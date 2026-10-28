/**
 * Contas sem data (F76): o que vai ter que ser pago, mas sem quando. Agendar cria uma transação
 * prevista; "já paguei" cria um lançamento manual. Se essa transação for apagada (ou o
 * agendamento desfeito), a conta volta para a lista.
 */
import { randomUUID } from "node:crypto"
import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import { finAccounts, finCategories, finPending, finTransactions } from "../../db/schema.js"
import { HttpError, notFound, withErrors } from "../../lib/http.js"
import { centsSchema, dayParam, idParams } from "./schemas.js"
import { snapshotCreated } from "./service.js"

const tags = ["finance"]
const errorSchema = z.object({ error: z.string(), message: z.string().optional() })

export const pendingSchema = z.object({
  id: z.string(),
  name: z.string(),
  estimate: centsSchema.nullable(),
  categoryId: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.date(),
})

const pendingInput = z.object({
  name: z.string().trim().min(1).max(120),
  estimate: centsSchema.min(0).nullable().optional(),
  categoryId: z.uuid().nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
})

/** Abertas: nunca fechadas, ou fechadas por uma transação que depois foi apagada. */
async function openPending() {
  const rows = await db
    .select({ pending: finPending, txDeleted: finTransactions.deletedAt })
    .from(finPending)
    .leftJoin(finTransactions, eq(finTransactions.id, finPending.transactionId))
    .where(
      or(
        isNull(finPending.closedAt),
        and(isNotNull(finPending.transactionId), isNotNull(finTransactions.deletedAt)),
      ),
    )
    .orderBy(asc(finPending.createdAt))
  return rows.map((r) => r.pending)
}

export const pendingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/finance/pending",
    {
      schema: {
        tags,
        summary: "Contas sem data (ainda não agendadas nem pagas)",
        response: withErrors({ 200: z.object({ items: z.array(pendingSchema) }) }),
      },
    },
    async () => ({ items: await openPending() }),
  )

  app.post(
    "/finance/pending",
    {
      schema: {
        tags,
        summary: "Nova conta sem data",
        body: pendingInput,
        response: withErrors({ 201: pendingSchema }),
      },
    },
    async (request, reply) => {
      const [row] = await db.insert(finPending).values(request.body).returning()
      return reply.code(201).send(row!)
    },
  )

  app.patch(
    "/finance/pending/:id",
    {
      schema: {
        tags,
        summary: "Alterar nome, valor estimado, categoria ou notas",
        params: idParams,
        body: pendingInput.partial(),
        response: withErrors({ 200: pendingSchema, 404: errorSchema }),
      },
    },
    async (request) => {
      const [row] = await db
        .update(finPending)
        .set(request.body)
        .where(eq(finPending.id, request.params.id))
        .returning()
      if (!row) throw notFound("Conta")
      return row
    },
  )

  app.delete(
    "/finance/pending/:id",
    {
      schema: {
        tags,
        summary: "Tirar da lista (não vou mais precisar)",
        params: idParams,
        response: withErrors({ 200: z.object({ ok: z.literal(true) }) }),
      },
    },
    async (request) => {
      await db
        .update(finPending)
        .set({ closedAt: new Date(), transactionId: null })
        .where(eq(finPending.id, request.params.id))
      return { ok: true as const }
    },
  )

  app.post(
    "/finance/pending/:id/schedule",
    {
      schema: {
        tags,
        summary: "Agendar (vira prevista) ou registrar como paga",
        params: idParams,
        body: z.object({
          date: dayParam,
          accountId: z.uuid(),
          /** Centavos, positivo; sem ele vale o valor estimado. */
          amount: centsSchema.min(1).optional(),
          paid: z.boolean().default(false),
        }),
        response: withErrors({
          200: z.object({ transactionId: z.string(), operationId: z.string() }),
          400: errorSchema,
          404: errorSchema,
        }),
      },
    },
    async (request) => {
      const [item] = await db.select().from(finPending).where(eq(finPending.id, request.params.id))
      if (!item) throw notFound("Conta")
      const amount = request.body.amount ?? item.estimate
      if (!amount) throw new HttpError(400, "amount_required", "Informe o valor.")
      const [account] = await db
        .select()
        .from(finAccounts)
        .where(eq(finAccounts.id, request.body.accountId))
      if (!account) throw new HttpError(400, "invalid_account", "Conta não encontrada.")
      if (item.categoryId) {
        const [cat] = await db
          .select({ id: finCategories.id })
          .from(finCategories)
          .where(eq(finCategories.id, item.categoryId))
        if (!cat) item.categoryId = null
      }
      const paid = request.body.paid
      const [tx] = await db
        .insert(finTransactions)
        .values({
          accountId: account.id,
          date: request.body.date,
          amount: -Math.abs(amount),
          description: item.name,
          categoryId: item.categoryId,
          categorySource: item.categoryId ? "user" : null,
          status: paid ? (item.categoryId ? "confirmed" : "review") : "planned",
          aiQuestion: paid && !item.categoryId ? "Lançado sem categoria. Qual é?" : null,
          // Pago à mão: junta com o extrato quando ele chegar (F34).
          manual: paid,
          notes: item.notes,
        })
        .returning({ id: finTransactions.id })
      await db
        .update(finPending)
        .set({ transactionId: tx!.id, closedAt: new Date() })
        .where(eq(finPending.id, item.id))
      const operationId = randomUUID()
      await snapshotCreated(operationId, [tx!.id])
      return { transactionId: tx!.id, operationId }
    },
  )
}
