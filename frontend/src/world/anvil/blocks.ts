/**
 * Block appearance table — how a block name becomes something drawable.
 *
 * Tier 1 of the plan: no textures, no resource pack, no Mojang assets. A hand
 * written colour per common block, then suffix heuristics, then a loud fallback
 * so an unrecognised block is visible rather than silently invisible. Modded
 * worlds land on the heuristics and still render as recognisable terrain.
 *
 * `solid` drives meshing (does this block emit faces at all); `opaque` drives
 * face culling and which pass it draws in.
 */

export interface BlockAppearance {
  /** False for air and for the decorations we deliberately do not model. */
  solid: boolean;
  /** False for water, glass, leaves — these do not cull their neighbours. */
  opaque: boolean;
  /** 0xRRGGBB. */
  color: number;
  /** 0..1, applied in the translucent pass only. */
  alpha: number;
}

const AIR: BlockAppearance = { solid: false, opaque: false, color: 0, alpha: 0 };
const UNKNOWN: BlockAppearance = { solid: true, opaque: true, color: 0xff00ff, alpha: 1 };

/** Blocks with no cube to draw. Anything not modelled as a full cube that would
 *  look worse as one than as nothing: plants, torches, rails, redstone. */
const SKIPPED = new Set([
  'air',
  'cave_air',
  'void_air',
  'barrier',
  'light',
  'structure_void',
  'torch',
  'wall_torch',
  'soul_torch',
  'soul_wall_torch',
  'redstone_torch',
  'redstone_wall_torch',
  'redstone_wire',
  'lever',
  'tripwire',
  'tripwire_hook',
  'rail',
  'powered_rail',
  'detector_rail',
  'activator_rail',
  'ladder',
  'vine',
  'string',
  'fire',
  'soul_fire',
  'cobweb',
  'snow',
  'grass',
  'short_grass',
  'tall_grass',
  'fern',
  'large_fern',
  'dead_bush',
  'seagrass',
  'tall_seagrass',
  'kelp',
  'kelp_plant',
  'sugar_cane',
  'wheat',
  'carrots',
  'potatoes',
  'beetroots',
  'nether_wort',
  'sweet_berry_bush',
  'lily_pad',
  'crimson_roots',
  'warped_roots',
  'nether_sprouts',
  'hanging_roots',
  'glow_lichen',
  'sculk_vein',
  'small_amethyst_bud',
  'medium_amethyst_bud',
  'large_amethyst_bud',
  'amethyst_cluster',
  'bamboo',
  'bamboo_sapling',
  'big_dripleaf',
  'big_dripleaf_stem',
  'small_dripleaf',
  'spore_blossom',
  'pointed_dripstone',
  'moss_carpet',
  'pink_petals',
  'flower_pot',
  'end_rod',
  'lightning_rod',
  'conduit',
  'turtle_egg',
  'sniffer_egg',
  'frogspawn',
  'repeater',
  'comparator',
  'waxed_lightning_rod',
  'brewing_stand',
  'azalea',
  'flowering_azalea',
  /* flowers — all one-block plants with no cube to draw */
  'dandelion',
  'poppy',
  'blue_orchid',
  'allium',
  'azure_bluet',
  'red_tulip',
  'orange_tulip',
  'white_tulip',
  'pink_tulip',
  'oxeye_daisy',
  'cornflower',
  'lily_of_the_valley',
  'wither_rose',
  'torchflower',
  'pitcher_plant',
  'sunflower',
  'lilac',
  'rose_bush',
  'peony',
  'brown_mushroom',
  'red_mushroom',
  'crimson_fungus',
  'warped_fungus',
  'sea_pickle',
  'wildflowers',
  'end_portal',
  'end_gateway'
]);

/** Flat or near-flat blocks that would read as a solid cube if drawn. Buttons
 *  and pressure plates are millimetres thick; a maze full of them rendered as
 *  full blocks looks like the walls are made of them. */
const FLAT_SUFFIXES =
  /_button$|_pressure_plate$|_sign$|_wall_sign$|_hanging_sign$|_banner$|_carpet$|_rail$|_plate$/;

/** Non-opaque full cubes: drawn, but they do not hide the block behind them. */
const TRANSLUCENT: Record<string, number> = {
  water: 0.62,
  bubble_column: 0.62,
  ice: 0.72,
  frosted_ice: 0.72,
  blue_ice: 0.85,
  packed_ice: 0.9,
  glass: 0.35,
  tinted_glass: 0.55,
  slime_block: 0.7,
  honey_block: 0.75,
  nether_portal: 0.7
};

/* Colours are eyeballed from the vanilla top-face textures. Ordered roughly by
   how often you actually see them, which is also the order worth extending. */
const COLORS: Record<string, number> = {
  /* terrain */
  stone: 0x7d7d7d,
  deepslate: 0x515154,
  granite: 0x9a6a5b,
  diorite: 0xbfbfbf,
  andesite: 0x8a8a8a,
  tuff: 0x6c6d63,
  calcite: 0xe0e0d8,
  dripstone_block: 0x866a56,
  dirt: 0x8b6a45,
  coarse_dirt: 0x7d5f3f,
  rooted_dirt: 0x91695a,
  podzol: 0x5b3d1c,
  mycelium: 0x6f6265,
  grass_block: 0x7cb342,
  farmland: 0x6b4726,
  dirt_path: 0x9b7f4a,
  mud: 0x3d3a3a,
  clay: 0xa3a8b4,
  gravel: 0x847e7c,
  sand: 0xdbd3a0,
  red_sand: 0xbe6720,
  sandstone: 0xd8ccA0,
  red_sandstone: 0xb3621e,
  bedrock: 0x565656,
  obsidian: 0x160d24,
  crying_obsidian: 0x22104a,
  netherrack: 0x703434,
  soul_sand: 0x51413a,
  soul_soil: 0x4c3d34,
  basalt: 0x4c4a4f,
  smooth_basalt: 0x48474d,
  blackstone: 0x2c252b,
  end_stone: 0xdadca0,
  magma_block: 0x8e3f18,
  snow_block: 0xf0fafa,
  powder_snow: 0xf5fbfb,
  moss_block: 0x596d2b,
  sculk: 0x0d1b1e,

  /* fluids */
  water: 0x3b6ecc,
  lava: 0xd45b12,
  flowing_water: 0x3b6ecc,
  flowing_lava: 0xd45b12,

  /* ores */
  coal_ore: 0x6b6b6b,
  iron_ore: 0xa0846f,
  copper_ore: 0x9a7b62,
  gold_ore: 0x9c8b53,
  redstone_ore: 0x9c6a6a,
  lapis_ore: 0x5f7391,
  diamond_ore: 0x6f9c99,
  emerald_ore: 0x6d9c72,
  ancient_debris: 0x5c4034,
  nether_quartz_ore: 0x8a5a55,
  nether_gold_ore: 0x8b5340,

  /* wood */
  oak_log: 0x9c7f4e,
  spruce_log: 0x5b4326,
  birch_log: 0xd7cdb0,
  jungle_log: 0x9b7248,
  acacia_log: 0xa85b34,
  dark_oak_log: 0x543c22,
  mangrove_log: 0x7a3327,
  cherry_log: 0xb4787f,
  crimson_stem: 0x6a2f43,
  warped_stem: 0x2b6b62,
  oak_planks: 0xb8945f,
  spruce_planks: 0x7b5c39,
  birch_planks: 0xd7c185,
  jungle_planks: 0xb1805c,
  acacia_planks: 0xba6337,
  dark_oak_planks: 0x4f3521,
  mangrove_planks: 0x773932,
  cherry_planks: 0xe3b9b4,
  bamboo_planks: 0xc2a44a,

  /* foliage */
  oak_leaves: 0x4f7f2f,
  spruce_leaves: 0x38562b,
  birch_leaves: 0x6e9a3b,
  jungle_leaves: 0x4a8021,
  acacia_leaves: 0x64882d,
  dark_oak_leaves: 0x3f6b25,
  mangrove_leaves: 0x477e34,
  cherry_leaves: 0xe6a4bd,
  azalea_leaves: 0x5b7f34,
  flowering_azalea_leaves: 0x6c8547,

  /* built */
  cobblestone: 0x7a7a7a,
  mossy_cobblestone: 0x6b7a5c,
  stone_bricks: 0x7a7a7a,
  mossy_stone_bricks: 0x6f7a63,
  cracked_stone_bricks: 0x767671,
  bricks: 0x96574a,
  glass: 0xc8e6ef,
  tinted_glass: 0x2e2b33,
  glowstone: 0xc9a153,
  sea_lantern: 0xa9c5bd,
  shroomlight: 0xd0762f,
  ice: 0x9dc0f5,
  packed_ice: 0x8ab2e8,
  blue_ice: 0x74a5e8,
  netherite_block: 0x40383c,
  iron_block: 0xdcdcdc,
  gold_block: 0xf3d64d,
  diamond_block: 0x63dbd4,
  emerald_block: 0x2fc85a,
  lapis_block: 0x1f4b9b,
  redstone_block: 0xaa1a09,
  copper_block: 0xc06a4e,
  bookshelf: 0x9c7f4e,
  crafting_table: 0x7d5b38,
  furnace: 0x6e6e6e,
  chest: 0x9c7f4e,
  hay_block: 0xa68b12,
  pumpkin: 0xc07615,
  melon: 0x7ba428,
  nether_bricks: 0x2e161a,
  purpur_block: 0xa77ca7,
  prismarine: 0x639a8f,
  terracotta: 0x985e44,

  /* 1.17-1.21 additions and the utility blocks that show up all over a played
     world — these were the bulk of the magenta fallbacks on a real save. */
  tuff_bricks: 0x60615a,
  chiseled_tuff: 0x5d5e56,
  chiseled_tuff_bricks: 0x5a5b53,
  polished_tuff: 0x686961,
  amethyst_block: 0x8964c8,
  budding_amethyst: 0x8f6ac6,
  raw_iron_block: 0xa9866a,
  raw_copper_block: 0x9c6a4e,
  raw_gold_block: 0xdda92a,
  mud_bricks: 0x8a6a52,
  packed_mud: 0x8f6b4c,
  bone_block: 0xe1ddc8,
  dried_kelp_block: 0x333d2a,
  sponge: 0xc3c34e,
  wet_sponge: 0xa8b046,
  ochre_froglight: 0xd9d09a,
  verdant_froglight: 0x9ac48f,
  pearlescent_froglight: 0xd7b8cd,
  reinforced_deepslate: 0x5a5d55,

  barrel: 0x81603a,
  chain: 0x3b3f4a,
  decorated_pot: 0xa4674f,
  candle: 0xe0d3b4,
  lantern: 0xb7863f,
  soul_lantern: 0x4e8b8f,
  campfire: 0x8a5a2f,
  lectern: 0x9c7b4a,
  composter: 0x7b5c39,
  smoker: 0x6a6a6a,
  blast_furnace: 0x585858,
  cartography_table: 0x6d5238,
  fletching_table: 0xc5b184,
  smithing_table: 0x3b3746,
  grindstone: 0x8a7f74,
  stonecutter: 0x7a7a7a,
  loom: 0xa2825a,
  beehive: 0xa8834d,
  bee_nest: 0xbb8b3d,
  target: 0xd6b7a5,
  scaffolding: 0xb59349,
  lodestone: 0x8a8a8f,
  respawn_anchor: 0x3a2350,
  note_block: 0x6a4b2c,
  jukebox: 0x604331,
  dispenser: 0x6e6e6e,
  dropper: 0x6e6e6e,
  observer: 0x5f5f5f,
  piston: 0x9c8150,
  sticky_piston: 0x8a9b4f,
  hopper: 0x40444b,
  cauldron: 0x45484d,
  anvil: 0x49494d,
  enchanting_table: 0x50302f,
  ender_chest: 0x2b4442,
  trapped_chest: 0x9c7f4e,
  spawner: 0x27363f,
  bell: 0xd0a63c,

  coal_block: 0x0e0e0e,
  command_block: 0xc19a7a,
  chain_command_block: 0x8fae95,
  repeating_command_block: 0x9a86b8,
  jigsaw: 0x54495a,
  structure_block: 0x5c4b5c,
  polished_andesite: 0x84868a,
  polished_diorite: 0xc5c5c8,
  polished_granite: 0x9c6753,
  smooth_stone: 0x9e9e9e,
  smooth_quartz: 0xe3ded6,
  quartz_block: 0xe8e3db,
  polished_blackstone: 0x2f2933,
  polished_blackstone_bricks: 0x2b262f,
  gilded_blackstone: 0x453036,
  glass_pane: 0xc8e6ef,
  purple_concrete: 0x64209c,
  redstone_lamp: 0x8d5b33,
  slime_block: 0x77c15b,
  honey_block: 0xfbb838,
  dirt_stairs: 0x8b6a45,

  cactus: 0x51843a,
  bamboo_block: 0x7b8f2c,
  bamboo_mosaic: 0xc2a44a,
  chiseled_bookshelf: 0xa0793f,
  daylight_detector: 0x7d6a4f,
  dragon_egg: 0x0d0a12,
  bubble_column: 0x3b6ecc,
  mushroom_stem: 0xcdc4b4,
  brown_mushroom_block: 0x976b4b,
  red_mushroom_block: 0xc73a34,
  nether_wart_block: 0x71090a,
  warped_wart_block: 0x167b7b,
  end_portal_frame: 0x3c6b5c,
  beacon: 0x74e0d8,
  cake: 0xe3ded6,
  chorus_plant: 0x5a3a5a,
  chorus_flower: 0x8a6a8a,
  honeycomb_block: 0xe08c22,
  polished_basalt: 0x565459,
  suspicious_sand: 0xd3c9a2,
  suspicious_gravel: 0x8d8785,
  trial_spawner: 0x2e3b40,
  vault: 0x33414a,
  heavy_core: 0x3a4148,
  crafter: 0x7a6a58
};

/** Rough colour for a family of blocks, matched on a substring of the id. */
const HEURISTICS: Array<[RegExp, number]> = [
  [/_leaves$/, 0x4f7f2f],
  [/^potted_/, 0xa4674f],
  [/purpur/, 0xa77ca7],
  [/cauldron$/, 0x45484d],
  [/candle/, 0xe0d3b4],
  [/froglight/, 0xd9d09a],
  [/amethyst/, 0x8964c8],
  [/tuff/, 0x60615a],
  [/shulker_box$/, 0x9a6c9a],
  [/_bed$|_banner$|_bed_|_head$|_skull$/, 0xb04a4a],
  [/lantern|campfire|torchflower/, 0xb7863f],
  [/lightning_rod/, 0xc06a4e],
  [/basalt/, 0x4c4a4f],
  [/_pot$|flower_pot/, 0xa4674f],
  [/chain|_bars$|anvil/, 0x3b3f4a],
  [/_log$|_wood$|_stem$|_hyphae$/, 0x8a6a42],
  [/_planks$|_door$|_trapdoor$|_sign$/, 0xb8945f],
  [/_wool$|_carpet$/, 0xdcdcdc],
  [/_concrete/, 0x8a8a8a],
  [/_terracotta$|_glazed/, 0x985e44],
  [/_stained_glass/, 0xc8e6ef],
  [/deepslate/, 0x515154],
  [/blackstone/, 0x2c252b],
  [/sandstone/, 0xd8cca0],
  [/copper/, 0xc06a4e],
  [/prismarine/, 0x639a8f],
  [/nether_brick/, 0x2e161a],
  [/_ore$/, 0x8a8073],
  [/_pane$/, 0xc8e6ef],
  [/andesite/, 0x84868a],
  [/diorite/, 0xc5c5c8],
  [/granite/, 0x9c6753],
  [/quartz/, 0xe8e3db],
  [/command_block|jigsaw|structure_block/, 0x54495a],
  [/_concrete_powder$/, 0xb0a68e],
  [/_concrete$|_glazed_terracotta$/, 0x8a8a8a],
  [/cobblestone|stone_brick|_stone$|^stone_/, 0x7a7a7a],
  [/_fence_gate$|_door$|_trapdoor$/, 0xb8945f],
  [/_slab$|_stairs$|_wall$|_fence$/, 0x8a8a8a],
  [/^potted_|_sapling$|_bush$|_fungus$|_flower$|_tulip$/, 0x4f7f2f],
  [/mushroom_block$|mushroom_stem/, 0xb0837a],
  [/_wart_block$/, 0x71090a],
  [/chorus/, 0x5a3a5a],
  [/bamboo/, 0x7b8f2c],
  [/coral/, 0xcc4f8a],
  [/mushroom/, 0xb0837a],
  [/sculk/, 0x0d1b1e],
  [/moss|_grass$/, 0x596d2b]
];

const cache = new Map<string, BlockAppearance>();

/** Strip the namespace: `minecraft:stone` -> `stone`. Modded ids keep theirs. */
function shortId(name: string): string {
  const colon = name.indexOf(':');
  if (colon < 0) return name;
  return name.slice(0, colon) === 'minecraft' ? name.slice(colon + 1) : name;
}

function compute(name: string): BlockAppearance {
  const id = shortId(name);
  if (SKIPPED.has(id) || FLAT_SUFFIXES.test(id)) return AIR;

  const alpha = TRANSLUCENT[id];
  const direct = COLORS[id];
  if (direct !== undefined) {
    return alpha !== undefined
      ? { solid: true, opaque: false, color: direct, alpha }
      : { solid: true, opaque: true, color: direct, alpha: 1 };
  }

  for (const [pattern, color] of HEURISTICS) {
    if (pattern.test(id)) {
      return alpha !== undefined
        ? { solid: true, opaque: false, color, alpha }
        : { solid: true, opaque: true, color, alpha: 1 };
    }
  }

  return UNKNOWN;
}

/**
 * Appearance for a block id. Memoised because a section's palette is walked
 * once per mesh rebuild and the same few hundred ids recur across a whole world.
 */
export function appearanceOf(name: string): BlockAppearance {
  let hit = cache.get(name);
  if (hit === undefined) {
    hit = compute(name);
    cache.set(name, hit);
  }
  return hit;
}

/** Names that fell through to the magenta fallback — surfaced in the UI so an
 *  unsupported world is diagnosable rather than just ugly. */
export function unknownBlockNames(): string[] {
  const out: string[] = [];
  for (const [name, a] of cache) if (a === UNKNOWN) out.push(name);
  return out.sort();
}
