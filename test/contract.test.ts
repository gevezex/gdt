import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ContractResult, validateContract } from "../src/contract.js";
import { loadLocale, type Locale } from "../src/locale.js";
import { EXAMPLE_CONFIG, fakePath, gdt, tempRepo } from "./helpers.js";

const en = loadLocale("en");
const nl = loadLocale("nl");

function ac(n: number, locale: Locale, omit: string[] = []): string {
  const f = locale.ac_fields;
  const lines = [
    [f.given, "a precondition"],
    [f.when, "an action"],
    [f.then, "an outcome"],
    [f.example, "`input` → `output`"],
  ]
    .filter(([label]) => !omit.includes(label as string))
    .map(([label, text]) => `- ${label}: ${text}`);
  return [`**AC-${n}: Criterion ${n}**`, "", ...lines].join("\n");
}

/** A valid body for `locale`; `overrides` replaces section contents by heading, `null` removes a section. */
function body(locale: Locale, overrides: Record<string, string | null> = {}, acs = 5): string {
  const s = locale.sections;
  const contents: [string, string][] = [
    [s.plain_language, "A short explanation."],
    [s.goal, "A goal."],
    [s.context, "- Some context."],
    [s.definitions, "| Term | Meaning |\n|---|---|\n| x | y |"],
    [s.acceptance_criteria, Array.from({ length: acs }, (_, i) => ac(i + 1, locale)).join("\n\n")],
    [s.non_functional, "- Fast enough."],
    [s.out_of_scope, "- Other things."],
    [s.assumptions, "- An assumption."],
    [s.open_questions, locale.markers.none],
    [s.changelog, "- 2026-09-26: Initial."],
    [s.readiness, "- [x] One.\n- [x] Two."],
  ];
  return contents
    .map(([heading, text]) => [heading, heading in overrides ? overrides[heading] : text] as const)
    .filter(([, text]) => text !== null)
    .map(([heading, text]) => `## ${heading}\n\n${text}\n`)
    .join("\n");
}

function check(text: string, locale: Locale = en, maxAcceptanceCriteria = 8): ContractResult {
  return validateContract(text, locale, { maxAcceptanceCriteria });
}

function repo(language = "en", max = 8): string {
  const config = EXAMPLE_CONFIG.replace('language = "nl"', `language = "${language}"`).replace(
    "max_acceptance_criteria = 8",
    `max_acceptance_criteria = ${max}`,
  );
  return tempRepo({ ".gdt/config.toml": config });
}

describe("AC-1: valid English contract passes", () => {
  it("prints the valid line with the AC count and exits 0", () => {
    const path = fakePath({ issueBody: body(en) });
    const result = gdt(["check-issue", "12"], repo(), path);
    expect(result.stdout).toBe("Issue #12: contract valid (5 acceptance criteria)\n");
    expect(result.code).toBe(0);
    expect(readFileSync(join(path, "gh-args"), "utf8").trim()).toBe("issue view 12 --json body");
  });

  it("prints the JSON result", () => {
    const result = gdt(["check-issue", "12", "--json"], repo(), fakePath({ issueBody: body(en) }));
    expect(JSON.parse(result.stdout)).toEqual({
      valid: true,
      acceptance_criteria: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5"],
      errors: [],
    });
    expect(result.code).toBe(0);
  });

  it("uses the defaults (en, maximum 8) without a config file", () => {
    const result = gdt(["check-issue", "12"], tempRepo(), fakePath({ issueBody: body(en) }));
    expect(result.stdout).toBe("Issue #12: contract valid (5 acceptance criteria)\n");
  });

  it("accepts CRLF line endings and bold field labels", () => {
    const bold = body(en).replace(/- (Given|When|Then|Example):/g, "- **$1:**");
    expect(check(bold.replace(/\n/g, "\r\n")).errors).toEqual([]);
  });
});

describe("AC-2: missing section is reported", () => {
  it("reports the missing section and exits 1", () => {
    const path = fakePath({ issueBody: body(en, { "Out of scope": null }) });
    const result = gdt(["check-issue", "12", "--json"], repo(), path);
    const json = JSON.parse(result.stdout) as ContractResult;
    expect(json.valid).toBe(false);
    expect(json.errors).toContain("Missing section: Out of scope");
    expect(result.code).toBe(1);
  });

  it("reports all errors in one run, in text output too", () => {
    const text = body(en, { "Out of scope": null, Goal: null, Readiness: "- [ ] Not done." });
    const result = gdt(["check-issue", "12"], repo(), fakePath({ issueBody: text }));
    expect(result.stdout).toBe(
      [
        "Issue #12: contract invalid (3 error(s))",
        "  - Missing section: Goal",
        "  - Missing section: Out of scope",
        "  - Readiness item not checked: Not done.",
        "",
      ].join("\n"),
    );
    expect(result.code).toBe(1);
  });

  it("does not count a level-3 heading or a heading inside a code block as a section", () => {
    const text = body(en, { "Out of scope": null, Assumptions: "- A.\n\n### Out of scope\n\n```\n## Out of scope\n```" });
    expect(check(text).errors).toEqual(["Missing section: Out of scope"]);
  });
});

describe("AC-3: incomplete acceptance criterion is reported", () => {
  it("reports a missing Example", () => {
    const acs = [ac(1, en), ac(2, en, ["Example"])].join("\n\n");
    expect(check(body(en, { "Acceptance criteria": acs })).errors).toEqual(['AC-2: missing "Example"']);
  });

  it("reports each missing field", () => {
    const acs = [ac(1, en), ac(2, en), ac(3, en, ["Given", "Then"])].join("\n\n");
    expect(check(body(en, { "Acceptance criteria": acs })).errors).toEqual([
      'AC-3: missing "Given"',
      'AC-3: missing "Then"',
    ]);
  });

  it("attributes each field to the criterion it follows", () => {
    const acs = [ac(1, en, ["When"]), "- When: in the wrong place?", ac(2, en)].join("\n\n");
    expect(check(body(en, { "Acceptance criteria": acs })).errors).toEqual([]);
    const moved = [ac(1, en, ["When"]), ac(2, en)].join("\n\n");
    expect(check(body(en, { "Acceptance criteria": moved })).errors).toEqual(['AC-1: missing "When"']);
  });
});

describe("AC-4: numbering and maximum count are enforced", () => {
  it("reports a gap in the numbering", () => {
    const acs = [ac(1, en), ac(3, en)].join("\n\n");
    const result = check(body(en, { "Acceptance criteria": acs }));
    expect(result.errors).toEqual(["Acceptance criteria must be numbered consecutively from AC-1; found AC-1, AC-3"]);
    expect(result.acceptance_criteria).toEqual(["AC-1", "AC-3"]);
  });

  it("reports criteria not starting at AC-1 and duplicates", () => {
    const start = check(body(en, { "Acceptance criteria": [ac(2, en), ac(3, en)].join("\n\n") }));
    expect(start.errors).toEqual(["Acceptance criteria must be numbered consecutively from AC-1; found AC-2, AC-3"]);
    const dup = check(body(en, { "Acceptance criteria": [ac(1, en), ac(1, en)].join("\n\n") }));
    expect(dup.errors).toEqual(["Acceptance criteria must be numbered consecutively from AC-1; found AC-1, AC-1"]);
  });

  it("reports more criteria than the maximum", () => {
    expect(check(body(en, {}, 9), en, 8).errors).toEqual(["9 acceptance criteria; maximum is 8"]);
    expect(check(body(en, {}, 8), en, 8).errors).toEqual([]);
  });

  it("reads the maximum from contract.max_acceptance_criteria", () => {
    const result = gdt(["check-issue", "12", "--json"], repo("en", 4), fakePath({ issueBody: body(en) }));
    expect((JSON.parse(result.stdout) as ContractResult).errors).toEqual(["5 acceptance criteria; maximum is 4"]);
    expect(result.code).toBe(1);
  });

  it("reports an acceptance criteria section without criteria", () => {
    expect(check(body(en, { "Acceptance criteria": "To do." })).errors).toEqual([
      'No acceptance criteria found in section "Acceptance criteria"',
    ]);
  });
});

describe("AC-5: open questions must be exactly the none marker", () => {
  it("rejects any other text", () => {
    expect(check(body(en, { "Open questions": "None. Maybe ask about X" })).errors).toEqual([
      'Open questions must be exactly "None."',
    ]);
    expect(check(body(en, { "Open questions": "" })).errors).toEqual(['Open questions must be exactly "None."']);
  });

  it("accepts the marker surrounded by whitespace", () => {
    expect(check(body(en, { "Open questions": "\n   None.  \n\n" })).errors).toEqual([]);
  });
});

describe("AC-6: vague phrases are rejected in every section", () => {
  it("names the phrase and the section", () => {
    expect(check(body(en, { Context: "- Loads files, settings, etc." })).errors).toEqual([
      'Vague phrase "etc." in section "Context"',
    ]);
  });

  it("checks every section, including extra ones", () => {
    const text = `${body(en, { Goal: "Make it user-friendly." })}\n## Notes\n\nAnd so on.\n`;
    expect(check(text).errors).toEqual([
      'Vague phrase "user-friendly" in section "Goal"',
      'Vague phrase "and so on" in section "Notes"',
    ]);
  });

  it("matches on word boundaries, case-insensitively", () => {
    expect(check(body(en, { Context: "Robustness matters." })).errors).toEqual([]);
    expect(check(body(en, { Context: "It must be ROBUST." })).errors).toEqual([
      'Vague phrase "robust" in section "Context"',
    ]);
    expect(check(body(en, { Context: "Etcetera and etc" })).errors).toEqual([]);
  });

  it("ignores inline code spans and fenced code blocks", () => {
    const text = body(en, {
      Context: "The list contains `etc.` and ``robust`` as phrases.\n\n```\nrobust etc.\n```\n\n~~~toml\nx = \"as usual\"\n~~~",
    });
    expect(check(text).errors).toEqual([]);
  });
});

describe("AC-7: Dutch locale validates Dutch headings", () => {
  const dutch = body(nl);

  it("accepts a Dutch body under nl", () => {
    expect(dutch).toContain("## Open vragen\n\nGeen.\n");
    const result = gdt(["check-issue", "12"], repo("nl"), fakePath({ issueBody: dutch }));
    expect(result.stdout).toBe("Issue #12: contract valid (5 acceptance criteria)\n");
    expect(result.code).toBe(0);
  });

  it("reports every English section the Dutch body lacks under en", () => {
    const result = check(dutch, en);
    const missing = Object.values(en.sections)
      .filter((heading) => !Object.values(nl.sections).includes(heading))
      .map((heading) => `Missing section: ${heading}`);
    expect(missing).toHaveLength(8);
    expect(result.errors.slice(0, missing.length)).toEqual(missing);
    expect(result.valid).toBe(false);
  });

  it("uses the Dutch field labels, none marker and vague phrases", () => {
    const acs = [ac(1, nl), ac(2, nl, ["Voorbeeld"])].join("\n\n");
    const text = body(nl, { "Acceptatiecriteria": acs, "Open vragen": "None.", Context: "Waar nodig." });
    expect(check(text, nl).errors).toEqual([
      'AC-2: missing "Voorbeeld"',
      'Open vragen must be exactly "Geen."',
      'Vague phrase "waar nodig" in section "Context"',
    ]);
  });
});

describe("AC-8: unchecked readiness items are reported", () => {
  it("reports each unchecked item", () => {
    const readiness = [
      "- [x] Happy paths, error paths and relevant edge cases are separate ACs.",
      "- [ ] Every AC can be turned into a test case without reading code.",
    ].join("\n");
    expect(check(body(en, { Readiness: readiness })).errors).toEqual([
      "Readiness item not checked: Every AC can be turned into a test case without reading code.",
    ]);
  });

  it("accepts checked items", () => {
    expect(check(body(en, { Readiness: "- [x] One.\n- [X] Two." })).errors).toEqual([]);
  });
});

describe("check-issue errors", () => {
  it.each([
    [[], 'Missing issue number for "gdt check-issue". Run "gdt check-issue --help".'],
    [["abc"], 'Unexpected argument "abc" for "gdt check-issue". Run "gdt check-issue --help".'],
    [["12", "--frob"], 'Unknown option "--frob" for "gdt check-issue". Run "gdt check-issue --help".'],
  ])("rejects %j as a usage error", (args, message) => {
    const result = gdt(["check-issue", ...args], repo());
    expect(result.stderr).toBe(`${message}\n`);
    expect(result.code).toBe(2);
  });

  it("reports a failing gh with a recovery hint", () => {
    const result = gdt(["check-issue", "12"], repo(), fakePath());
    expect(result.stderr).toContain("Could not fetch issue #12: GraphQL: Could not resolve to an issue.");
    expect(result.stderr).toContain('run "gdt doctor"');
    expect(result.code).toBe(1);
  });

  it("reports a language without a shipped locale", () => {
    const result = gdt(["check-issue", "12"], repo("fr"), fakePath({ issueBody: body(en) }));
    expect(result.stderr).toBe('No locale for language "fr"; set language in .gdt/config.toml to one of en, nl\n');
    expect(result.code).toBe(1);
  });

  it("refuses to run with an invalid config", () => {
    const root = tempRepo({ ".gdt/config.toml": "language = 1\n" });
    const result = gdt(["check-issue", "12"], root, fakePath({ issueBody: body(en) }));
    expect(result.stderr).toBe('.gdt/config.toml is invalid. Run "gdt doctor" for details.\n');
    expect(result.code).toBe(1);
  });
});
