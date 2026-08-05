/**
 * Every way a world can fail to load, with a code the UI can branch on.
 *
 * These surface directly to the user — a world that won't open is the single
 * most likely thing to go wrong, so the message has to say what to do about it
 * rather than just what broke.
 */

export type AnvilErrorCode =
  | 'bad-region'
  | 'external-chunk'
  | 'unsupported-compression'
  | 'unsupported-version'
  | 'legacy-format'
  | 'incomplete-chunk'
  | 'bad-chunk';

export class AnvilError extends Error {
  constructor(
    readonly code: AnvilErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AnvilError';
  }
}

/** Lowest DataVersion we parse: 1.18 (21w43a), the release that moved chunks
 *  off the `Level` compound and dropped the world floor to y=-64. */
export const MIN_DATA_VERSION = 2825;

export const unsupportedVersion = (found: number) =>
  new AnvilError(
    'unsupported-version',
    `World is too old to open: chunk DataVersion ${found}, need ${MIN_DATA_VERSION} or newer (Minecraft 1.18+). Open the world once in a 1.18 or later client to convert it.`
  );

/**
 * The pre-1.18 chunk layout: everything nested under a `Level` compound, with
 * `Sections`/`Palette`/`BlockStates` instead of `sections`/`block_states`.
 *
 * Worth its own message because this is what most world-generation libraries
 * still emit — Python's `anvil-parser` in particular — so a programmatically
 * built world hits this rather than the plain version gate, and "your world is
 * old" is misleading when the world was written yesterday.
 */
export const legacyChunkFormat = (found: number) =>
  new AnvilError(
    'legacy-format',
    `Chunk uses the pre-1.18 \`Level\` layout${found ? ` (DataVersion ${found})` : ''}. That is the format Python's anvil-parser and similar libraries write. Either generate with a library that targets 1.18+ (DataVersion ${MIN_DATA_VERSION} or newer, sections at the chunk root), or load the world once in a 1.18+ client to convert it.`
  );
