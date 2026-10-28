/**
 * Dívidas (F84): o que alguém emprestou para vocês. Sem cronograma: cada pagamento é livre, vira
 * uma saída na conta (categoria Dívidas) e abate do saldo. Se a saída for apagada no fluxo (ou o
 * pagamento desfeito), ela deixa de contar. Quitada = pagamentos cobrem o valor.
 */
import { randomUUID } from "node:crypto"
import { and, asc, eq, isNull, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"
import { db } from "../../db/client.js"
import {
  finAccounts,
  finCategories,
  finDebtPayments,
  finDebts,
  finTransactions,
} from "../../db/schema.js"
import { HttpError, notFound, withErrors } from "../../lib/http.js"
import { today } from "./dates.js"
import { centsSchema, dayParam, idParams } from "./schemas.js"
import { snapshotCreated } from "./service.js"

const tags = ["finance"]
const errorSchema = z.object({ error: z.string(), message: z.string().optional() })
const DEBT_CATEGORY = "Dívidas"

export const debtSchema = z.object({
  id: z.string(),
  name: z.string(),
  amount: centsSchema,
  startedOn: z.string(),
  notes: z.string().nullable(),
  paid: centsSchema,
  remaining: centsSchema,
  payments: z.array(
    z.object({
      id: z.string(),
      date: z.string(),
      amount: centsSchema,
      transactionId: z.string().nullable(),
    }),
  ),
})

const debtInput = z.object({
  name: z.string().trim().min(1).max(120),
  amount: centsSchema.min(1),
  startedOn: dayParam.optional(),
  notes: z.string().trim().max(500).nullable().optional(),
})

/** Pagamentos que contam: a saída criada ainda existe. */
async function countedPayments() {
  return db
    .select({ payment: finDebtPayments })
    .from(finDebtPayments)
    .innerJoin(finTransactions, eq(finTransactions.id, finDebtPayments.transactionId))
    .where(isNull(finTransactions.deletedAt))
    .orderBy(asc(finDebtPayments.date), asc(finDebtPayments.createdAt))
    .then((rows) => rows.map((r) => r.payment))
}

async function listDebts() {
  const [debts, payments] = await Promise.all([
    db
      .select()
      .from(finDebts)
      .where(isNull(finDebts.archivedAt))
      .orderBy(asc(finDebts.startedOn), asc(finDebts.createdAt)),
    countedPayments(),
  ])
  return debts.map((d) => {
    const mine = payments.filter((p) => p.debtId === d.id)
    const paid = mine.reduce((s, p) => s + p.amount, 0)
    return {
      id: d.id,
      name: d.name,
      amount: d.amount,
      startedOn: d.startedOn,
      notes: d.notes,
      paid,
      remaining: Math.max(0, d.amount - paid),
      payments: mine.map((p) => ({
        id: p.id,
        date: p.date,
        amount: p.amount,
        transactionId: p.transactionId,
      })),
    }
  })
}

/** Quanto falta pagar das dívidas no fim de `day` (para o patrimônio). */
export async function debtsLeftAt(day: string) {
  const [debts, payments] = await Promise.all([
    db.select().from(finDebts).where(isNull(finDebts.archivedAt)),
    countedPayments(),
  ])
  return debts
    .filter((d) => d.startedOn <= day)
    .reduce((sum, d) => {
      const paid = payments
        .filter((p) => p.debtId === d.id && p.date <= day)
        .reduce((s, p) => s + p.amount, 0)
      return sum + Math.max(0, d.amount - paid)
    }, 0)
}

/** Categoria das saídas de pagamento; criada na primeira vez se ainda não existir. */
async function debtCategoryId() {
  const [found] = await db
    .select({ id: finCategories.id })
    .from(finCategories)
    .where(
      and(
        sql`lower(${finCategories.name}) = lower(${DEBT_CATEGORY})`,
        isNull(finCategories.archivedAt),
      ),
    )
  if (found) return found.id
  const [created] = await db
    .insert(finCategories)
    .values({ name: DEBT_CATEGORY, kind: "expense", nature: "fixed" })
    .returning({ id: finCategories.id })
  return created!.id
}

export const debtRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/finance/debts",
    {
      schema: {
        tags,
        summary: "Dívidas (o que vocês devem) com pagamentos e quanto falta",
        response: withErrors({ 200: z.object({ items: z.array(debtSchema) }) }),
      },
    },
    async () => ({ items: await listDebts() }),
  )

  app.post(
    "/finance/debts",
    {
      schema: {
        tags,
        summary: "Nova dívida",
        body: debtInput,
        response: withErrors({ 201: z.object({ id: z.string() }) }),
      },
    },
    async (request, reply) => {
      const { startedOn, ...rest } = request.body
      const [row] = await db
        .insert(finDebts)
        .values({ ...rest, startedOn: startedOn ?? today() })
        .returning({ id: finDebts.id })
      return reply.code(201).send(row!)
    },
  )

  app.patch(
    "/finance/debts/:id",
    {
      schema: {
        tags,
        summary: "Alterar nome, valor, data ou notas",
        params: idParams,
        body: debtInput.partial(),
        response: withErrors({ 200: z.object({ ok: z.literal(true) }), 404: errorSchema }),
      },
    },
    async (request) => {
      const [row] = await db
        .update(finDebts)
        .set(request.body)
        .where(eq(finDebts.id, request.params.id))
        .returning({ id: finDebts.id })
      if (!row) throw notFound("Dívida")
      return { ok: true as const }
    },
  )

  app.delete(
    "/finance/debts/:id",
    {
      schema: {
        tags,
        summary: "Tirar da lista (os pagamentos já feitos continuam no fluxo)",
        params: idParams,
        response: withErrors({ 200: z.object({ ok: z.literal(true) }) }),
      },
    },
    async (request) => {
      await db
        .update(finDebts)
        .set({ archivedAt: new Date() })
        .where(eq(finDebts.id, request.params.id))
      return { ok: true as const }
    },
  )

  app.post(
    "/finance/debts/:id/payments",
    {
      schema: {
        tags,
        summary: "Registrar um pagamento (vira uma saída na conta)",
        params: idParams,
        body: z.object({ date: dayParam, accountId: z.uuid(), amount: centsSchema.min(1) }),
        response: withErrors({
          200: z.object({
            transactionId: z.string(),
            operationId: z.string(),
            remaining: centsSchema,
          }),
          400: errorSchema,
          404: errorSchema,
        }),
      },
    },
    async (request) => {
      const [debt] = await db.select().from(finDebts).where(eq(finDebts.id, request.params.id))
      if (!debt || debt.archivedAt) throw notFound("Dívida")
      const [account] = await db
        .select({ id: finAccounts.id })
        .from(finAccounts)
        .where(eq(finAccounts.id, request.body.accountId))
      if (!account) throw new HttpError(400, "invalid_account", "Conta não encontrada.")
      const categoryId = await debtCategoryId()
      const [tx] = await db
        .insert(finTransactions)
        .values({
          accountId: account.id,
          date: request.body.date,
          amount: -request.body.amount,
          description: `Pagamento: ${debt.name}`,
          categoryId,
          categorySource: "user",
          status: "confirmed",
          // Lançado à mão: junta com o extrato quando ele chegar (F34).
          manual: true,
        })
        .returning({ id: finTransactions.id })
      await db.insert(finDebtPayments).values({
        debtId: debt.id,
        transactionId: tx!.id,
        date: request.body.date,
        amount: request.body.amount,
      })
      const operationId = randomUUID()
      await snapshotCreated(operationId, [tx!.id])
      const remaining = (await listDebts()).find((d) => d.id === debt.id)?.remaining ?? 0
      return { transactionId: tx!.id, operationId, remaining }
    },
  )
}
