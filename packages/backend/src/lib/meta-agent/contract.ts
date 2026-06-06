// ---------------------------------------------------------------------------
// Output contract validation (Tier 1: structural).
//
// A contract is a simplified JSON Schema that describes what an agent's tick
// should produce. The validator checks type, required fields, array item
// shapes, and nested objects. It does NOT support $ref, allOf/anyOf/oneOf,
// pattern, or other advanced JSON Schema features.
//
// Supported schema keywords: type, properties, required, items, description.
// Supported types: object, array, string, number, boolean, null.
//
// Returns a list of issues (empty = pass). Never throws.
// ---------------------------------------------------------------------------

export interface ContractIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ContractIssue[];
}

interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  description?: string;
}

export function validateContract(
  payload: unknown,
  contract: Record<string, unknown>,
): ValidationResult {
  const issues: ContractIssue[] = [];
  validate(payload, contract as SchemaNode, "", issues);
  return { valid: issues.length === 0, issues };
}

function validate(
  value: unknown,
  schema: SchemaNode,
  path: string,
  issues: ContractIssue[],
): void {
  if (!schema || typeof schema !== "object") return;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!types.includes(actual)) {
      issues.push({
        path: path || "(root)",
        message: `expected ${types.join("|")}, got ${actual}`,
      });
      return;
    }
  }

  if (schema.type === "object" || (!schema.type && schema.properties)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      if (!schema.type) {
        issues.push({ path: path || "(root)", message: `expected object, got ${typeOf(value)}` });
      }
      return;
    }

    const obj = value as Record<string, unknown>;

    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj) || obj[key] === undefined) {
          issues.push({
            path: path ? `${path}.${key}` : key,
            message: "required field missing",
          });
        }
      }
    }

    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          validate(obj[key], propSchema, path ? `${path}.${key}` : key, issues);
        }
      }
    }
  }

  if (schema.type === "array" || (!schema.type && schema.items)) {
    if (!Array.isArray(value)) {
      if (!schema.type) {
        issues.push({ path: path || "(root)", message: `expected array, got ${typeOf(value)}` });
      }
      return;
    }

    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        validate(value[i], schema.items, `${path}[${i}]`, issues);
      }
    }
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
