import { readdirSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

export const SECTION_KEYS = [
  "plain_language",
  "goal",
  "context",
  "definitions",
  "acceptance_criteria",
  "non_functional",
  "out_of_scope",
  "assumptions",
  "open_questions",
  "changelog",
  "readiness",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

const text = z.string().trim().min(1);

export const localeSchema = z.strictObject({
  /** English name of the language, used in role prompts. */
  name: text,
  sections: z.strictObject(Object.fromEntries(SECTION_KEYS.map((key) => [key, text])) as Record<SectionKey, typeof text>),
  ac_fields: z.strictObject({ given: text, when: text, then: text, example: text }),
  markers: z.strictObject({ none: text }),
  vague_phrases: z.array(text),
});

export type Locale = z.infer<typeof localeSchema>;

const LOCALES_DIR = new URL("../locales/", import.meta.url);

/** Loads `locales/<language>.toml` shipped with gdt. Throws with a recovery hint when it is missing or invalid. */
export function loadLocale(language: string): Locale {
  const languages = shippedLanguages();
  if (!languages.includes(language)) {
    throw new Error(`No locale for language "${language}"; set language in .gdt/config.toml to one of ${languages.join(", ")}`);
  }
  const parsed = localeSchema.safeParse(parseToml(readFileSync(new URL(`${language}.toml`, LOCALES_DIR), "utf8")));
  if (!parsed.success) {
    throw new Error(`locales/${language}.toml is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export function shippedLanguages(): string[] {
  return readdirSync(LOCALES_DIR)
    .filter((name) => name.endsWith(".toml"))
    .map((name) => name.slice(0, -".toml".length))
    .sort();
}
