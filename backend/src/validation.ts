import { z } from 'zod';

export const uuid = z.string().uuid();

export const GROUP_DISPLAY_STYLES = ['rectangle', 'outline', 'loop'] as const;
const displayStyle = z.enum(GROUP_DISPLAY_STYLES).optional();
const bodyPadding = z.number().finite().min(0).max(400).nullable().optional();

export const mapCreate = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).optional()
});

export const mapUpdate = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10_000).optional(),
  /** null clears it; the location must live on this map. */
  startLocationId: uuid.nullable().optional()
});

export const groupCreate = z.object({
  name: z.string().max(200).optional(),
  color: z.string().max(40).optional(),
  textColor: z.string().max(40).optional(),
  notes: z.string().max(100_000).optional(),
  displayStyle,
  bodyPadding,
  parentId: uuid.nullable().optional(),
  locationIds: z.array(uuid).max(10_000).optional(),
  defaultKind: z.string().max(60).optional(),
  defaultSize: z.number().finite().positive().max(25).nullable().optional(),
  defaultColor: z.string().max(40).optional(),
  defaultTextColor: z.string().max(40).optional(),
  overrideLabels: z.boolean().optional()
});

export const groupUpdate = groupCreate.omit({ locationIds: true });

export const locationCreate = z.object({
  name: z.string().max(200).optional(),
  kind: z.string().max(60).optional(),
  size: z.number().finite().positive().max(25).optional(),
  notes: z.string().max(100_000).optional(),
  color: z.string().max(40).optional(),
  textColor: z.string().max(40).optional(),
  /** Initial memberships; [0] becomes the anchor. */
  groupIds: z.array(uuid).max(200).optional(),
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
  overrideGroupings: z.boolean().optional(),
  /** Replaces the whole set. Structure, never styling. */
  restartTargets: z.array(uuid).max(200).optional(),
  restartName: z.string().max(200).optional(),
  /** 0 is legal: a restart may be declared free. */
  restartWeight: z.number().finite().min(0).max(10_000).optional()
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

export const groupAssign = z.object({
  groupId: uuid,
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
  /** Resolved against `locations[].key`; unresolvable means "no default start". */
  startLocationKey: z.string().nullable().optional(),
  groups: z
    .array(
      z.object({
        key: z.string().min(1).max(200),
        parentKey: z.string().nullable().optional(),
        name: z.string().max(200).optional(),
        color: z.string().max(40).optional(),
        textColor: z.string().max(40).optional(),
        notes: z.string().max(100_000).optional(),
        displayStyle,
        bodyPadding,
        defaultKind: z.string().max(60).optional(),
        defaultSize: z.number().finite().positive().max(25).nullable().optional(),
        defaultColor: z.string().max(40).optional(),
        defaultTextColor: z.string().max(40).optional(),
        overrideLabels: z.boolean().optional()
      })
    )
    .max(20_000)
    .optional(),
  locationLabels: z
    .array(
      /* targets travel as keys, like every other cross-reference in an export */
      locationLabelCreate.omit({ restartTargets: true }).extend({
        key: z.string().min(1).max(200),
        restartTargetKeys: z.array(z.string()).optional()
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
      locationCreate.omit({ groupIds: true, coordX: true, coordY: true, coordZ: true }).extend({
        key: z.string().min(1).max(200),
        /** Legacy single membership, still accepted on import. */
        groupKey: z.string().nullable().optional(),
        groupKeys: z.array(z.string()).optional(),
        labelKeys: z.array(z.string()).optional(),
        /* `coord × grid unit` can reach model-space extremes the renderer's
           extent model and coordinate layout were never sized for; imports
           from an older export are clamped rather than rejected outright */
        coordX: z.number().int().min(-10_000).max(10_000).nullable().optional(),
        coordY: z.number().int().min(-10_000).max(10_000).nullable().optional(),
        coordZ: z.number().int().min(-10_000).max(10_000).nullable().optional()
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
