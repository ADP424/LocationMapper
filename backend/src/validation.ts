import { z } from 'zod';

export const uuid = z.string().uuid();

export const mapCreate = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).optional()
});

export const mapUpdate = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10_000).optional()
});

export const locationCreate = z.object({
  name: z.string().max(200).optional(),
  kind: z.string().max(60).optional(),
  layer: z.string().max(120).optional(),
  notes: z.string().max(100_000).optional(),
  color: z.string().max(40).optional(),
  textColor: z.string().max(40).optional(),
  visited: z.boolean().optional(),
  pinned: z.boolean().optional(),
  x: z.number().finite().nullable().optional(),
  y: z.number().finite().nullable().optional()
});

export const locationUpdate = locationCreate;

const connectionFields = {
  name: z.string().max(200).optional(),
  notes: z.string().max(100_000).optional(),
  travelKind: z.string().max(60).optional(),
  color: z.string().max(40).optional(),
  textColor: z.string().max(40).optional(),
  arrowSource: z.boolean().optional(),
  arrowTarget: z.boolean().optional(),
  ephemeral: z.boolean().optional(),
  locked: z.boolean().optional(),
  lockNote: z.string().max(2_000).optional(),
  weight: z.number().finite().positive().max(10_000).optional(),
  requires: z.array(uuid).max(200).optional()
};

export const connectionCreate = z.object({
  sourceId: uuid,
  targetId: uuid,
  ...connectionFields
});

export const connectionUpdate = z.object({
  sourceId: uuid.optional(),
  targetId: uuid.optional(),
  ...connectionFields
});

export const positionsUpdate = z.object({
  positions: z
    .array(
      z.object({
        id: uuid,
        x: z.number().finite(),
        y: z.number().finite(),
        pinned: z.boolean().optional()
      })
    )
    .max(100_000)
});

export const graphImport = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).optional(),
  locations: z.array(locationCreate.extend({ key: z.string().min(1).max(200) })),
  connections: z.array(
    z.object({
      sourceKey: z.string().min(1),
      targetKey: z.string().min(1),
      requiresKeys: z.array(z.string()).optional(),
      ...connectionFields
    }).omit({ requires: true })
  )
});
