/**
 * Scalar function example: `greet`.
 *
 * A scalar maps each input row to one output row. VGI hands `compute` a whole
 * Arrow column at a time (not one value), and expects a column of the same
 * length back.
 *
 * SQL has no named arguments for scalar functions, so an optional argument is
 * an *overload*: two functions that share the SQL name `greet` and differ in
 * arity. DuckDB picks one by the number of arguments.
 *
 * `style` is a constant parameter (`const: true`). It must be a constant in the
 * query (not a column), and its `choices` are enforced when the query is
 * bound, so `greet('Ada', 'loud')` fails with a helpful error before any row
 * runs.
 */

import { defineScalarFunction, utf8, type VgiBatch } from "@query-farm/vgi";
import { objectTags } from "./meta.ts";

export const STYLES = ["casual", "formal"] as const;
export type Style = (typeof STYLES)[number];

const PREFIX: Record<Style, string> = { casual: "Hi, ", formal: "Good day, " };
const SUFFIX: Record<Style, string> = { casual: "!", formal: "." };

const NAME_DOC = "Person or thing to greet; NULL in, NULL out.";
const STYLE_DOC = "Greeting tone: 'casual' gives 'Hi, <name>!', 'formal' gives 'Good day, <name>.'";

/** Build greetings for a whole column; NULL names stay NULL. */
export function greetAll(names: Iterable<string | null>, style: Style): (string | null)[] {
  return Array.from(names, (name) => (name == null ? null : `${PREFIX[style]}${name}${SUFFIX[style]}`));
}

function names(batch: VgiBatch): Iterable<string | null> {
  return (batch.getChildAt(0) ?? []) as Iterable<string | null>;
}

/** `greet(name)`: a casual greeting for every row. */
export const greet = defineScalarFunction({
  name: "greet",
  description: "Greet a name casually: greet('Ada') returns 'Hi, Ada!'",
  params: { name: utf8() },
  argDocs: { name: NAME_DOC },
  returns: utf8(),
  compute: (batch) => greetAll(names(batch), "casual"),
  tags: objectTags({
    title: "Greet (casual)",
    category: "text",
    keywords: "greet, greeting, hello, salutation, welcome message",
    docLlm:
      "Return a **casual greeting** for each input name: greeting Ada returns 'Hi, Ada!'. " +
      "NULL names produce NULL. This is the one-argument overload; call the two-argument " +
      "form `greet(name, style)` for the formal tone. It is a vectorized scalar, so it works " +
      "over a whole column, one result per row:\n\n" +
      "```sql\nSELECT starter.main.greet(name) FROM people;\n```",
    docMd:
      "## greet(name)\n\n" +
      "A casual greeting for each row: Ada becomes 'Hi, Ada!'.\n\n" +
      "NULL in, NULL out. See `greet(name, style)` for the formal tone.",
  }),
  examples: [{ sql: "SELECT starter.main.greet('Ada') AS greeting", description: "Greet one name casually" }],
});

/** `greet(name, style)`: a greeting in the chosen tone. */
export const greetWithStyle = defineScalarFunction({
  name: "greet",
  description: "Greet a name in a chosen tone: greet('Ada', 'formal') returns 'Good day, Ada.'",
  // The ordered `parameters` form is the one that carries constraints, so
  // `choices` is published to agents and enforced at bind.
  parameters: [
    { name: "name", type: utf8(), doc: NAME_DOC },
    { name: "style", type: utf8(), const: true, doc: STYLE_DOC, choices: STYLES },
  ],
  returns: utf8(),
  compute: (batch, consts) => greetAll(names(batch), consts.style as Style),
  tags: objectTags({
    title: "Greet (with tone)",
    category: "text",
    keywords: "greet, greeting, formal greeting, casual greeting, salutation, tone",
    docLlm:
      "Return a greeting for each input name in the requested tone. `style` must be a " +
      "constant, either 'casual' (Ada becomes 'Hi, Ada!') or 'formal' (Ada becomes " +
      "'Good day, Ada.'); any other value is rejected when the query is planned. NULL names " +
      "produce NULL.",
    docMd:
      "## greet(name, style)\n\n" +
      "A greeting in the chosen tone: 'casual' or 'formal'.\n\n" +
      "Formally, Ada becomes 'Good day, Ada.'",
  }),
  examples: [{ sql: "SELECT starter.main.greet('Ada', 'formal') AS greeting", description: "Greet one name formally" }],
});
