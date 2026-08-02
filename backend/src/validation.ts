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

export const groupCreate = z.object({
  name: z.string().max(200).optional(),
  color: z.string().max(40).optional(),
  textColor: z.string().max(40).optional(),
  notes: z.string().max(100_000).optional(),
  parentId: uuid.nullable().optional(),
  locationIds: z.array(uuid).max(10_000).optional()
});

export const groupUpdate = groupCreate.omit({ locationIds: true });

export const locationCreate = z.object({
  name: z.string().max(200).optional(),
  kind: z.string().max(60).optional(),
  size: z.number().finite().positive().max(25).optional(),
  layer: z.string().max(120).optional(),
  notes: z.string().max(100_000).optional(),
  color: z.string().max(40).optional(),
  textColor: z.string().max(40).optional(),
  groupId: uuid.nullable().optional(),
  visited: z.boolean().optional(),
  x: z.number().finite().nullable().optional(),
  y: z.number().finite().nullable().optional(),
  coordX: z.number().int().min(-1_000_000).max(1_000_000).nullable().optional(),
  coordY: z.number().int().min(-1_000_000).max(1_000_000).nullable().optional(),
  coordZ: z.number().int().min(-1_000_000).max(1_000_000).nullable().optional()
});

export const locationUpdate = locationCreate;

/** Everything a connection carries except its endpoints and unlock conditions. */
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
  outDx: z.number().finite().nullable().optional(),
  outDy: z.number().finite().nullable().optional(),
  inDx: z.number().finite().nullable().optional(),
  inDy: z.number().finite().nullable().optional()
};

const requires = z.array(uuid).max(200).optional();

export const connectionCreate = z.object({
  sourceId: uuid,
  targetId: uuid,
  requires,
  ...connectionFields
});

export const connectionUpdate = z.object({
  sourceId: uuid.optional(),
  targetId: uuid.optional(),
  requires,
  ...connectionFields
});

export const locationLabelCreate = z.object({
  name: z.string().max(200).optional(),
  color: z.string().max(40).optional(),
  notes: z.string().max(100_000).optional(),
  defaultKind: z.string().max(60).optional(),
  defaultSize: z.number().finite().positive().max(25).nullable().optional(),
  defaultColor: z.string().max(40).optional(),
  defaultTextColor: z.string().max(40).optional(),
  defaultLayer: z.string().max(120).optional(),
  defaultGroupId: uuid.nullable().optional()
});

export const locationLabelUpdate = locationLabelCreate;

export const connectionLabelCreate = z.object({
  name: z.string().max(200).optional(),
  color: z.string().max(40).optional(),
  notes: z.string().max(100_000).optional(),
  defaultColor: z.string().max(40).optional(),
  defaultTextColor: z.string().max(40).optional(),
  defaultTravelKind: z.enum(['', 'default', 'solid', 'dashed', 'dotted']).optional(),
  defaultDirection: z.enum(['', 'forward', 'backward', 'both', 'none']).optional(),
  defaultWeight: z.number().finite().positive().max(10_000).nullable().optional(),
  defaultEphemeral: z.boolean().nullable().optional(),
  defaultLocked: z.boolean().nullable().optional(),
  defaultLockNote: z.string().max(2_000).optional(),
  defaultRequires: z.array(uuid).max(200).optional()
});

export const connectionLabelUpdate = connectionLabelCreate;

export const labelAssign = z.object({
  labelId: uuid,
  applyStyling: z.boolean().optional()
});

export const positionsUpdate = z.object({
  positions: z
    .array(z.object({ id: uuid, x: z.number().finite(), y: z.number().finite() }))
    .max(100_000)
    .optional()
    .default([]),
  /** Ephemeral stub boxes, stored relative to their anchor room. */
  portalOffsets: z
    .array(
      z.object({
        connectionId: uuid,
        side: z.enum(['out', 'in']),
        dx: z.number().finite(),
        dy: z.number().finite()
      })
    )
    .max(100_000)
    .optional()
    .default([])
});

/* Array sizes are bounded so one request can't hold a transaction open forever. */
export const graphImport = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).optional(),
  groups: z
    .array(
      z.object({
        key: z.string().min(1).max(200),
        parentKey: z.string().nullable().optional(),
        name: z.string().max(200).optional(),
        color: z.string().max(40).optional(),
        textColor: z.string().max(40).optional(),
        notes: z.string().max(100_000).optional()
      })
    )
    .max(20_000)
    .optional(),
  locationLabels: z
    .array(
      locationLabelCreate.extend({
        key: z.string().min(1).max(200),
        defaultGroupKey: z.string().nullable().optional()
      })
    )
    .max(5_000)
    .optional(),
  connectionLabels: z
    .array(
      connectionLabelCreate.omit({ defaultRequires: true }).extend({
        key: z.string().min(1).max(200),
        defaultRequiresKeys: z.array(z.string()).optional()
      })
    )
    .max(5_000)
    .optional(),
  locations: z
    .array(
      locationCreate.omit({ groupId: true }).extend({
        key: z.string().min(1).max(200),
        groupKey: z.string().nullable().optional(),
        labelKeys: z.array(z.string()).optional()
      })
    )
    .max(50_000),
  connections: z
    .array(
      z.object({
        sourceKey: z.string().min(1),
        targetKey: z.string().min(1),
        requiresKeys: z.array(z.string()).optional(),
        labelKeys: z.array(z.string()).optional(),
        ...connectionFields
      })
    )
    .max(200_000)
});
