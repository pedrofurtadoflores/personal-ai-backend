import type { buildApp } from "../src/app.js"
import { TEST_PASSWORD } from "./constants.js"

type App = Awaited<ReturnType<typeof buildApp>>

let ipCounter = 1

/** IP único por chamada, para o rate limit e o bloqueio de um teste não afetarem outro. */
export function uniqueIp() {
  ipCounter += 1
  return `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`
}

export async function login(app: App, password = TEST_PASSWORD, remoteAddress = uniqueIp()) {
  return app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { password },
    remoteAddress,
  })
}

export async function loginToken(app: App) {
  const response = await login(app)
  return response.json<{ token: string }>().token
}

export function bearer(token: string) {
  return { authorization: `Bearer ${token}` }
}
