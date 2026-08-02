import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * The mounted inspector's pending draft.
 *
 *   commit — apply it; clicking outside the panel and unmounting both do this
 *   cancelCommit — suppress that commit for good (used by keyboard delete, so
 *     an unmount does not PATCH a row that is already gone)
 */
export const inspectorCommit: { current: null | (() => void) } = { current: null };
export const inspectorCancel: { current: null | (() => void) } = { current: null };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Only the fields the user actually changed, so every PATCH stays minimal. */
function changedFields<T>(draft: T, base: T, fields: readonly (keyof T)[]): Partial<T> {
  const patch: Partial<T> = {};
  for (const f of fields) if (!same(draft[f], base[f])) patch[f] = draft[f];
  return patch;
}

/**
 * Fold a freshly-arrived server row into the draft the user is still editing.
 *
 * Several inspector controls apply *immediately* and hand back a new row —
 * adding or re-stamping a label, picking a grouping, ticking Visited, swapping
 * endpoints, or a re-stamp triggered from somewhere else entirely. Reloading the
 * draft from that row would throw away whatever is half-typed, so instead:
 *
 *   • a field the user has touched keeps their value, whatever the server says
 *   • every other field follows the server
 *
 * So nothing typed is ever lost. The only way to abandon a draft is **Revert**,
 * which re-reads this same row — which is also how you take a label's stamp for
 * a field you had already edited by hand.
 */
function mergeDraft<T>(draft: T, base: T, server: T, fields: readonly (keyof T)[]): T {
  const merged = { ...server };
  for (const f of fields) if (!same(draft[f], base[f])) merged[f] = draft[f];
  return merged;
}

export interface Draft<T> {
  draft: T;
  setDraft: Dispatch<SetStateAction<T>>;
  dirty: boolean;
  /** Writes whatever the user changed; resolves once the write has been issued. */
  commit: () => Promise<void>;
  revert: () => void;
  /** Suppress the commit that would otherwise fire on unmount (after Delete). */
  cancelCommit: () => void;
}

/**
 * Every inspector follows the same contract: edit a local draft, apply it on
 * **Apply**, on clicking outside the panel, or on unmount; revert it on
 * **Revert**; and merge in any newer row the server hands back meanwhile.
 */
export function useDraft<T extends { id: string; updatedAt: string }>(
  entity: T,
  fields: readonly (keyof T)[],
  save: (id: string, patch: Partial<T>) => void | Promise<unknown>,
  normalise: (entity: T) => T = (e) => e
): Draft<T> {
  const [draft, setDraft] = useState<T>(() => normalise(entity));

  const draftRef = useRef(draft);
  draftRef.current = draft;

  /** The row the draft is measured against: the server's, plus anything we just saved. */
  const baseRef = useRef(draft);
  const syncedAtRef = useRef(entity.updatedAt);

  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const saveRef = useRef(save);
  saveRef.current = save;
  const normaliseRef = useRef(normalise);
  normaliseRef.current = normalise;
  const skipRef = useRef(false);

  useEffect(() => {
    if (syncedAtRef.current === entity.updatedAt) return; // mount, or our own write
    syncedAtRef.current = entity.updatedAt;

    const server = normaliseRef.current(entity);
    const base = baseRef.current;
    baseRef.current = server;
    setDraft((current) => mergeDraft(current, base, server, fieldsRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.id, entity.updatedAt]);

  const commit = useCallback(async () => {
    if (skipRef.current) return;
    const patch = changedFields(draftRef.current, baseRef.current, fieldsRef.current);
    if (!Object.keys(patch).length) return;
    /* move the baseline first, so the row that comes back does not look like an
       external change and merge our own write on top of itself */
    baseRef.current = { ...baseRef.current, ...patch };
    await saveRef.current(draftRef.current.id, patch);
  }, []);

  const cancelCommit = useCallback(() => {
    skipRef.current = true;
  }, []);

  useEffect(() => {
    inspectorCommit.current = commit;
    inspectorCancel.current = cancelCommit;
    return () => {
      if (inspectorCommit.current === commit) {
        inspectorCommit.current = null;
        inspectorCancel.current = null;
      }
      void commit();
    };
  }, [commit, cancelCommit]);

  return {
    draft,
    setDraft,
    dirty: Object.keys(changedFields(draft, baseRef.current, fields)).length > 0,
    commit,
    revert: () => setDraft(normaliseRef.current(baseRef.current)),
    cancelCommit
  };
}
