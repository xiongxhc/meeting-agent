// Project names come from the language model as free text. TeamMem gives
// every new name its own project page and withholds a whole meeting whose
// name differs from an existing project only by case, so the artifact may
// carry only exact names TeamMem already published. A proposed name matches a
// published one when they are equal after Unicode NFC, trimming, collapsing
// whitespace and lower-casing. Anything else is flagged in the artifact's
// processing warnings instead of being published as a project. Those flags are
// bounded: a meeting is never withheld because the model proposed many names.

type ProposedProject = { readonly name: string; readonly evidence_segment_ids: readonly string[] };
type Warning = { readonly code: string; readonly detail: string };

/** The artifact contract's bound on evidence IDs per project. */
const MAX_EVIDENCE_IDS = 100;
/** Names flagged one by one; the rest are counted in a single warning. */
const MAX_NAMED_UNASSIGNED = 20;
/** The artifact contract's bound on a project name. */
const MAX_NAME_LENGTH = 200;
/** Bound on the published names handed to synthesis. */
export const MAX_KNOWN_PROJECTS = 500;

/** The published names synthesis may choose from, within the artifact's bounds. */
export function synthesisProjectVocabulary(known: readonly string[] | null | undefined): string[] {
  return (known ?? []).filter((name) => name.length > 0 && name.length <= MAX_NAME_LENGTH).slice(0, MAX_KNOWN_PROJECTS);
}

const matchKey = (name: string) => name.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();

/** `known` null means the published project list could not be read.
 * `maxWarnings` is the room left under the artifact's warning limit; the
 * returned warnings never exceed it. */
export function resolveProjects(proposed: readonly ProposedProject[], known: readonly string[] | null, maxWarnings = Infinity): {
  readonly projects: { name: string; evidence_segment_ids: string[] }[];
  readonly warnings: Warning[];
} {
  const published = new Map<string, string | null>();
  for (const name of known ?? []) {
    const key = matchKey(name);
    published.set(key, published.has(key) && published.get(key) !== name ? null : name);
  }
  const resolved = new Map<string, { name: string; evidence_segment_ids: string[] }>();
  const unassigned = new Map<string, string>();
  for (const project of proposed) {
    const key = matchKey(project.name);
    const name = published.get(key);
    if (name === undefined || name === null) {
      if (!unassigned.has(key)) unassigned.set(key, project.name);
      continue;
    }
    const entry = resolved.get(name) ?? { name, evidence_segment_ids: [] };
    resolved.set(name, entry);
    for (const id of project.evidence_segment_ids) {
      if (entry.evidence_segment_ids.length < MAX_EVIDENCE_IDS && !entry.evidence_segment_ids.includes(id)) entry.evidence_segment_ids.push(id);
    }
  }
  const warnings: Warning[] = known === null && proposed.length > 0
    ? [{ code: "project_index_unavailable", detail: "The published project list could not be read." }] : [];
  const names = [...unassigned.values()];
  const room = Math.max(0, maxWarnings - warnings.length);
  const named = names.length <= Math.min(room, MAX_NAMED_UNASSIGNED) ? names.length
    : Math.max(0, Math.min(room, MAX_NAMED_UNASSIGNED + 1) - 1);
  for (const name of names.slice(0, named)) warnings.push({ code: "project_unassigned", detail: name });
  if (named < names.length && room > 0) {
    warnings.push({ code: "project_unassigned_more", detail: `${names.length - named} further proposed projects are not in the published project list.` });
  }
  return { projects: [...resolved.values()], warnings: warnings.slice(0, Math.max(0, maxWarnings)) };
}
