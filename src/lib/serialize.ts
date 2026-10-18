import { z } from "zod"

/** Datas trafegam como strings ISO 8601 (o JSON Schema não representa Date). */
export const isoDate = z.iso.datetime({ offset: true })

type Jsonified<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonified<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonified<T[K]> }
      : T

/** Converte recursivamente as datas de uma linha do banco em strings ISO. */
export function jsonDates<T>(value: T): Jsonified<T> {
  if (value instanceof Date) return value.toISOString() as Jsonified<T>
  if (Array.isArray(value)) return value.map(jsonDates) as Jsonified<T>
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonDates(item)]),
    ) as Jsonified<T>
  }
  return value as Jsonified<T>
}
