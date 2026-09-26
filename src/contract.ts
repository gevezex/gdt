import { type Locale, SECTION_KEYS } from "./locale.js";

/** Serialised as-is by `gdt check-issue --json`; keep these keys stable. */
export interface ContractResult {
  valid: boolean;
  acceptance_criteria: string[];
  errors: string[];
}

export interface ContractOptions {
  maxAcceptanceCriteria: number;
}

interface Line {
  text: string;
  /** Inside a fenced code block (fence lines included). */
  code: boolean;
}

/** A level-2 heading and the lines up to the next level-2 heading. */
interface Section {
  heading: string;
  lines: Line[];
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const AC_HEADING = /^\s*(?:#{3,6}\s+|\*\*)AC-(\d+)\b/;
const UNCHECKED = /^\s*[-*+]\s+\[ \]\s+(.*)$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Marks lines inside fenced code blocks, so headings and phrases in code are ignored. */
function classify(body: string): Line[] {
  const lines: Line[] = [];
  let fence: string | null = null;
  for (const text of body.replace(/\r\n?/g, "\n").split("\n")) {
    const match = FENCE.exec(text);
    if (fence === null) {
      if (match?.[1] !== undefined) fence = match[1];
      lines.push({ text, code: fence !== null });
    } else {
      const closing = match?.[1];
      if (closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length && text.trim() === closing) {
        fence = null;
      }
      lines.push({ text, code: true });
    }
  }
  return lines;
}

function splitSections(body: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of classify(body)) {
    const heading = line.code ? null : /^## (.*)$/.exec(line.text);
    if (heading?.[1] !== undefined) {
      current = { heading: heading[1].trim(), lines: [] };
      sections.push(current);
    } else {
      current?.lines.push(line);
    }
  }
  return sections;
}

function prose(lines: readonly Line[]): string[] {
  return lines.filter((line) => !line.code).map((line) => line.text);
}

function acceptanceCriteria(section: Section, locale: Locale, options: ContractOptions): { ids: string[]; errors: string[] } {
  const blocks: { number: number; lines: string[] }[] = [];
  for (const text of prose(section.lines)) {
    const heading = AC_HEADING.exec(text);
    if (heading?.[1] !== undefined) blocks.push({ number: Number(heading[1]), lines: [] });
    else blocks.at(-1)?.lines.push(text);
  }

  const ids = blocks.map((block) => `AC-${block.number}`);
  if (blocks.length === 0) {
    return { ids, errors: [`No acceptance criteria found in section "${section.heading}"`] };
  }

  const errors: string[] = [];
  if (blocks.some((block, i) => block.number !== i + 1)) {
    errors.push(`Acceptance criteria must be numbered consecutively from AC-1; found ${ids.join(", ")}`);
  }
  if (blocks.length > options.maxAcceptanceCriteria) {
    errors.push(`${blocks.length} acceptance criteria; maximum is ${options.maxAcceptanceCriteria}`);
  }

  const fields = [locale.ac_fields.given, locale.ac_fields.when, locale.ac_fields.then, locale.ac_fields.example];
  for (const [i, block] of blocks.entries()) {
    for (const field of fields) {
      // "- Given: ...", also "- **Given:** ..." and "- **Given**: ...".
      const pattern = new RegExp(`^\\s*[-*+]\\s+(?:\\*\\*)?${escapeRegExp(field)}(?::|\\*\\*\\s*:|\\s+:)`);
      if (!block.lines.some((line) => pattern.test(line))) errors.push(`${ids[i]}: missing "${field}"`);
    }
  }
  return { ids, errors };
}

function withoutInlineCode(text: string): string {
  return text.replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, " ");
}

function vaguePhraseErrors(sections: readonly Section[], phrases: readonly string[]): string[] {
  const patterns = phrases.map((phrase) => ({
    phrase,
    // Word boundaries that also hold for non-ASCII letters and for phrases ending in punctuation ("etc.").
    regex: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}_])`, "iu"),
  }));
  const errors: string[] = [];
  for (const section of sections) {
    const text = withoutInlineCode([section.heading, ...prose(section.lines)].join("\n"));
    for (const { phrase, regex } of patterns) {
      if (regex.test(text)) errors.push(`Vague phrase "${phrase}" in section "${section.heading}"`);
    }
  }
  return errors;
}

/** The trimmed text of the first section with `heading`, or undefined when the body has none. */
export function sectionText(body: string, heading: string): string | undefined {
  const section = splitSections(body).find((s) => s.heading === heading);
  return section?.lines.map((line) => line.text).join("\n").trim();
}

/** Validates an issue body against the contract for `locale`. Pure: no I/O. */
export function validateContract(body: string, locale: Locale, options: ContractOptions): ContractResult {
  const sections = splitSections(body);
  const find = (heading: string) => sections.find((section) => section.heading === heading);
  const errors: string[] = [];

  for (const key of SECTION_KEYS) {
    const heading = locale.sections[key];
    if (find(heading) === undefined) errors.push(`Missing section: ${heading}`);
  }

  let ids: string[] = [];
  const acSection = find(locale.sections.acceptance_criteria);
  if (acSection !== undefined) {
    const result = acceptanceCriteria(acSection, locale, options);
    ids = result.ids;
    errors.push(...result.errors);
  }

  const openQuestions = find(locale.sections.open_questions);
  if (openQuestions !== undefined && openQuestions.lines.map((line) => line.text).join("\n").trim() !== locale.markers.none) {
    errors.push(`${locale.sections.open_questions} must be exactly "${locale.markers.none}"`);
  }

  errors.push(...vaguePhraseErrors(sections, locale.vague_phrases));

  const readiness = find(locale.sections.readiness);
  if (readiness !== undefined) {
    for (const text of prose(readiness.lines)) {
      const item = UNCHECKED.exec(text)?.[1];
      if (item !== undefined) errors.push(`Readiness item not checked: ${item.trim()}`);
    }
  }

  return { valid: errors.length === 0, acceptance_criteria: ids, errors };
}
