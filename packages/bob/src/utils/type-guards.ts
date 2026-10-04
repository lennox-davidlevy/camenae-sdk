export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export function isString<T>(value: T): value is T & string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Primitive boundary predicate; callers validate the domain contract.
  return typeof value === "string";
}

export function isNumber<T>(value: T): value is T & number {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Primitive boundary predicate; callers validate the domain contract.
  return typeof value === "number";
}

export function isBoolean<T>(value: T): value is T & boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Primitive boundary predicate; callers validate the domain contract.
  return typeof value === "boolean";
}

export function isFunction<T>(value: T): value is T & ((...args: never[]) => void) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Establish callability without invoking untrusted input.
  return typeof value === "function";
}

export function isBigInt<T>(value: T): value is T & bigint {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Primitive classification for runtimeTypeName diagnostics.
  return typeof value === "bigint";
}

export function isSymbol<T>(value: T): value is T & symbol {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Primitive classification for runtimeTypeName diagnostics.
  return typeof value === "symbol";
}

export function isRecord<T>(value: T): value is T & JsonObject {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Initial object gate; callers must validate fields (isJsonValue validates recursively).
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue<T>(value: T): value is T & JsonValue {
  if (value === null || isString(value) || isNumber(value) || isBoolean(value)) return true;

  if (Array.isArray(value)) return value.every(isJsonValue);

  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function toJsonValue<T>(value: T): JsonValue {
  if (!isJsonValue(value)) throw new TypeError("Value must be JSON serializable");

  return value;
}

export function runtimeTypeName<T>(value: T): string {
  if (isString(value)) return "string";

  if (isNumber(value)) return "number";

  if (isBoolean(value)) return "boolean";

  if (isFunction(value)) return "function";

  if (value === undefined) return "undefined";

  if (isBigInt(value)) return "bigint";

  if (isSymbol(value)) return "symbol";

  return "object";
}

export function hasStringCode<T>(value: T): value is T & { code: string } {
  return isRecord(value) && isString(value.code);
}
