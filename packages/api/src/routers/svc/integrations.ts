/* eslint-disable @typescript-eslint/no-misused-promises */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { stringify } from 'csv-stringify'
import express from 'express'
import { DateTime } from 'luxon'
import { v4 as uuidv4 } from 'uuid'
import { IntegrationType } from '../../entity/integration'
import { LibraryItem } from '../../entity/library_item'
import { EntityType, readPushSubscription } from '../../pubsub'
import { Claims } from '../../resolvers/types'
import {
  findIntegration,
  getIntegrationService,
  updateIntegration,
} from '../../services/integrations'
import {
  findLibraryItemById,
  searchLibraryItems,
} from '../../services/library_item'
import { getClaimsByToken } from '../../utils/auth'
import { logger } from '../../utils/logger'
import { DateFilter } from '../../utils/search'
import { createGCSFile } from '../../utils/uploads'

export interface Message {
  type?: EntityType
  id?: string
  userId: string
  pageId?: string
  articleId?: string
}

interface ImportEvent {
  integrationId: string
}

const isImportEvent = (event: any): event is ImportEvent =>
  'integrationId' in event

export function integrationsServiceRouter() {
  const router = express.Router()

  router.post('/:integrationName/:action', async (req, res) => {
    logger.info('start to sync with integration', {
      action: req.params.action,
      integrationName: req.params.integrationName,
    })

    try {
      const { message: msgStr, expired } = readPushSubscription(req)

      if (!msgStr) {
        return res.status(200).send('Bad Request')
      }

      if (expired) {
        logger.info('discarding expired message')
        return res.status(200).send('Expired')
      }

      const data: Message = JSON.parse(msgStr)
      const userId = data.userId
      const type = data.type
      if (!userId) {
        logger.info('No userId found in message')
        res.status(200).send('Bad Request')
        return
      }

      const integration = await findIntegration(
        {
          name: req.params.integrationName.toUpperCase(),
          type: IntegrationType.Export,
          enabled: true,
        },
        userId
      )
      if (!integration) {
        logger.info('No active integration found for user', { userId })
        res.status(200).send('No integration found')
        return
      }

      const action = req.params.action.toUpperCase()
      const integrationService = getIntegrationService(integration.name)
      if (action === 'SYNC_UPDATED') {
        // get updated page by id
        let id: string | undefined
        switch (type) {
          case EntityType.PAGE:
            id = data.id
            break
          case EntityType.HIGHLIGHT:
            id = data.articleId
            break
          case EntityType.LABEL:
            id = data.pageId
            break
        }
        if (!id) {
          logger.info('No id found in message')
          res.status(200).send('Bad Request')
          return
        }
        const item = await findLibraryItemById(id, userId)
        if (!item) {
          logger.info('No item found for id', { id })
          res.status(200).send('No page found')
          return
        }

        // sync updated item with integration
        logger.info('syncing updated item with integration', {
          integrationId: integration.id,
          itemId: item.id,
        })

        const synced = await integrationService.export(integration, [item])
        if (!synced) {
          logger.info('failed to sync item', {
            integrationId: integration.id,
            itemId: item.id,
          })
          return res.status(400).send('Failed to sync')
        }
      } else if (action === 'SYNC_ALL') {
        // sync all pages of the user
        const size = 50

        for (
          let hasNextPage = true,
            count = 0,
            after = 0,
            items: LibraryItem[] = [];
          hasNextPage;
          after += size, hasNextPage = count > after
        ) {
          const syncedAt = integration.syncedAt
          // only sync pages that were updated after syncedAt
          const dateFilters: DateFilter[] = []
          syncedAt &&
            dateFilters.push({ field: 'updatedAt', startDate: syncedAt })
          const { libraryItems } = await searchLibraryItems(
            { from: after, size, dateFilters },
            userId
          )
          items = libraryItems
          const itemIds = items.map((p) => p.id)

          logger.info('syncing items', { pageIds: itemIds })

          const synced = await integrationService.export(integration, items)
          if (!synced) {
            logger.error('failed to sync items', {
              pageIds: itemIds,
              integrationId: integration.id,
            })
            return res.status(400).send('Failed to sync')
          }
        }
        // delete task name if completed
        await updateIntegration(
          integration.id,
          {
            taskName: null,
          },
          userId
        )
      } else {
        logger.info('unknown action', { action })
        res.status(200).send('Unknown action')
        return
      }
    } catch (err) {
      logger.error('sync with integrations failed', err)
      return res.status(500).send(err)
    }

    res.status(200).send('OK')
  })

  // import pages from integration task handler
  router.post('/import', async (req, res) => {
    logger.info('start cloud task to import pages from integration')
    const token = req.cookies?.auth || req.headers?.authorization
    let claims: Claims | undefined
    try {
      claims = await getClaimsByToken(token)
      if (!claims) {
        return res.status(401).send('UNAUTHORIZED')
      }
    } catch (err) {
      logger.error('failed to get claims from token', err)
      return res.status(401).send('UNAUTHORIZED')
    }

    if (!isImportEvent(req.body)) {
      logger.info('Invalid message')
      return res.status(400).send('Bad Request')
    }

    let writeStream: NodeJS.WritableStream | undefined
    try {
      const userId = claims.uid
      const integration = await findIntegration(
        {
          id: req.body.integrationId,
          enabled: true,
          type: IntegrationType.Import,
        },
        userId
      )
      if (!integration) {
        logger.info('No active integration found for user', { userId })
        return res.status(200).send('No integration found')
      }

      const integrationService = getIntegrationService(integration.name)
      // import pages from integration
      logger.info('importing pages from integration', {
        integrationId: integration.id,
      })

      let offset = 0
      const since = integration.syncedAt?.getTime() || 0
      let syncedAt = since

      // get pages from integration
      const retrieved = await integrationService.retrieve({
        token: integration.token,
        since,
        offset,
      })
      syncedAt = retrieved.since || Date.now()

      let retrievedData = retrieved.data
      // if there are pages to import
      if (retrievedData.length > 0) {
        // write the list of urls to a csv file and upload it to gcs
        // path style: imports/<uid>/<date>/<type>-<uuid>.csv
        const dateStr = DateTime.now().toISODate()
        const fileUuid = uuidv4()
        const fullPath = `imports/${userId}/${dateStr}/URL_LIST-${fileUuid}.csv`
        // open a write_stream to the file
        const file = createGCSFile(fullPath)
        writeStream = file.createWriteStream({
          contentType: 'text/csv',
        })
        // stringify the data and pipe it to the write_stream
        const stringifier = stringify({
          header: true,
          columns: ['url', 'state', 'labels'],
        })
        stringifier.pipe(writeStream)

        // paginate api calls to the integration
        do {
          // write the list of urls, state and labels to the stream
          retrievedData.forEach((row) => stringifier.write(row))

          // get next pages from the integration
          offset += retrievedData.length

          const retrieved = await integrationService.retrieve({
            token: integration.token,
            since,
            offset,
          })
          syncedAt = retrieved.since || Date.now()
          retrievedData = retrieved.data

          logger.info('retrieved data', {
            total: offset,
            size: retrievedData.length,
          })
        } while (retrievedData.length > 0 && offset < 20000) // limit to 20k pages
      }

      // update the integration's syncedAt and remove taskName
      await updateIntegration(
        integration.id,
        {
          syncedAt: new Date(syncedAt),
          taskName: null,
        },
        userId
      )
    } catch (err) {
      logger.error('import pages from integration failed', err)
      return res.status(500).send(err)
    } finally {
      writeStream?.end()
    }

    res.status(200).send('OK')
  })

  return router
}
