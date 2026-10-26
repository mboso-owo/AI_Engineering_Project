import { appEvents } from '../lib/events';
import { cacheDel } from '../lib/cache';
import { errorToLogObject, logger } from '../lib/logger';

// When a role changes, bust the permissions cache for that user
appEvents.on('admin:role-assigned', async (data) => {
  try {
    await cacheDel(`permissions:${data.targetUserId}`);
    logger.info('Permissions cache invalidated', {
      targetUserId: data.targetUserId,
    });
  } catch (error) {
    logger.error('Failed to bust permissions cache', {
      error: errorToLogObject(error),
    });
  }
});

appEvents.on('admin:role-revoked', async (data) => {
  try {
    await cacheDel(`permissions:${data.targetUserId}`);
  } catch (error) {
    logger.error('Failed to bust permissions cache', {
      error: errorToLogObject(error),
    });
  }
});

// When a document is updated or deleted, bust its cache
appEvents.on('doc:deleted', async (data) => {
  try {
    await cacheDel(`doc:${data.documentId}`);
  } catch (error) {
    logger.error('Failed to bust document cache', {
      error: errorToLogObject(error),
    });
  }
});
