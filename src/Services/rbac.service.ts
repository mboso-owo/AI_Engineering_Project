import { cacheGet, cacheSet, cacheDel, CACHE_TTL } from '../lib/cache';
import { prisma } from '../lib/prisma';

export async function getUserPermissions(
  userId: string
): Promise<Set<string>> {
  const cacheKey = `permissions:${userId}`;

  // 1. Check cache
  const cached = await cacheGet<string[]>(cacheKey);
  if (cached) {
    return new Set(cached);
  }

  // 2. Cache miss — load from database
  const userRoles = await prisma.userRole.findMany({
    where: { userId },
    include: {
      role: {
        include: {
          permissions: {
            include: { permission: true },
          },
        },
      },
    },
  });

  const permissions = new Set<string>();
  for (const ur of userRoles) {
    for (const rp of ur.role.permissions) {
      permissions.add(rp.permission.name);
    }
  }

  // 3. Store in cache
  await cacheSet(cacheKey, [...permissions], CACHE_TTL.PERMISSIONS);

  return permissions;
}

