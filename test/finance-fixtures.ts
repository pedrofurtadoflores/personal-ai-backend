/**
 * Extratos sintéticos no formato real dos bancos (sem dados de ninguém): fatura do Nubank em OFX
 * (com FITID repetido no IOF, parcela, estorno e pagamento) e extrato da conta do Bradesco em CSV.
 */

const ofxRow = (type: string, date: string, amount: string, fitid: string, memo: string) =>
  `<STMTTRN>\n<TRNTYPE>${type}</TRNTYPE>\n<DTPOSTED>${date}000000[-3:BRT]</DTPOSTED>\n<TRNAMT>${amount}</TRNAMT>\n<FITID>${fitid}</FITID>\n<MEMO>${memo}</MEMO>\n</STMTTRN>`

export function nubankInvoiceOfx(opts: {
  start: string
  end: string
  server?: string
  balance: string
  rows: [type: string, date: string, amount: string, fitid: string, memo: string][]
}) {
  return [
    "OFXHEADER:100",
    "DATA:OFXSGML",
    "VERSION:102",
    "SECURITY:NONE",
    "ENCODING:USASCII",
    "CHARSET:1252",
    "COMPRESSION:NONE",
    "OLDFILEUID:NONE",
    "NEWFILEUID:NONE",
    "<OFX>",
    "<SIGNONMSGSRSV1>",
    "<SONRS>",
    `<DTSERVER>${opts.server ?? "20261028"}130110[0:GMT]</DTSERVER>`,
    "<LANGUAGE>POR</LANGUAGE>",
    "<FI>",
    "<ORG>NU PAGAMENTOS S.A.</ORG>",
    "<FID>260</FID>",
    "</FI>",
    "</SONRS>",
    "</SIGNONMSGSRSV1>",
    "<CREDITCARDMSGSRSV1>",
    "<CCSTMTTRNRS>",
    "<CCSTMTRS>",
    "<CURDEF>BRL</CURDEF>",
    "<CCACCTFROM>",
    "<ACCTID>00000000-0000-0000-0000-000000000000</ACCTID>",
    "</CCACCTFROM>",
    "<BANKTRANLIST>",
    `<DTSTART>${opts.start}000000[-3:BRT]</DTSTART>`,
    `<DTEND>${opts.end}000000[-3:BRT]</DTEND>`,
    ...opts.rows.map((r) => ofxRow(...r)),
    "</BANKTRANLIST>",
    "<LEDGERBAL>",
    `<BALAMT>${opts.balance}</BALAMT>`,
    `<DTASOF>${opts.end}000000[-3:BRT]</DTASOF>`,
    "</LEDGERBAL>",
    "</CCSTMTRS>",
    "</CCSTMTTRNRS>",
    "</CREDITCARDMSGSRSV1>",
    "</OFX>",
  ].join("\n")
}

/** Fatura de outubro (fecha 03/10): compras, IOF com o FITID da compra, parcela, estorno e pagamento. */
export const OCT_INVOICE = nubankInvoiceOfx({
  start: "20260904",
  end: "20261004",
  balance: "-480.50",
  rows: [
    ["DEBIT", "20261003", "-108.66", "aaa-1", "Servico Nuvem Inc."],
    ["DEBIT", "20261003", "-3.80", "aaa-1", 'IOF de "Servico Nuvem Inc."'],
    ["DEBIT", "20261002", "-52.41", "bbb-2", "Posto Exemplo"],
    ["DEBIT", "20261002", "-52.41", "bbb-3", "Posto Exemplo"],
    ["DEBIT", "20260920", "-100.00", "ccc-4", "Loja Moda - Parcela 3/10"],
    ["DEBIT", "20260915", "-163.22", "ddd-5", "Amazonmktplc*Lojaexemplo"],
    ["CREDIT", "20260918", "105.80", "eee-6", 'Estorno de "Posto Exemplo"'],
    ["CREDIT", "20260911", "900.00", "fff-7", "Pagamento recebido"],
    ["DEBIT", "20260910", "-105.80", "ggg-8", "Posto Exemplo"],
  ],
})

/** Fatura futura (fev): só parcelas já programadas, gerada em 28/10. */
export const FEB_INVOICE = nubankInvoiceOfx({
  start: "20270104",
  end: "20270204",
  balance: "-100.00",
  rows: [["DEBIT", "20270120", "-100.00", "ccc-7", "Loja Moda - Parcela 7/10"]],
})

/** Extrato da conta do Bradesco, com título, saldo por linha, rodapé e seção de futuros vazia. */
export const BRADESCO_CSV = [
  "﻿Extrato de: Ag: 0000 | Conta: 00000-0;;;;;",
  "Data;Histórico;Docto.;Crédito (R$);Débito (R$);Saldo (R$)",
  "01/10/2026;PIX QR CODE DINAMICO;1000001; ;6,90;1.000,00",
  "05/10/2026;TED RECEBIDA EMPRESA EXEMPLO;1000002;5.000,00; ;6.000,00",
  "05/10/2026;PAGTO ELETRON  COBRANCA;3; ;1.200,00;4.800,00",
  "10/10/2026;PIX ENVIADO;1000004; ;150,00;4.650,00",
  "12/10/2026;PIX ENVIADO;1000005; ;48,00;4.602,00",
  ";;;;;",
  ";;;;;",
  "Os dados acima tem como base 28/10/2026 às 09:58 e estão sujeitos a alterações.;;;;;",
  ";;;;;",
  "Lançamentos Futuros;;;;;",
  "Data;Histórico;Docto.;Crédito (R$);Débito (R$);",
  ";;;;Não há lançamentos disponíveis;",
  ";;;;;",
  ";;Total;0,00;0,00;0,00",
].join("\n")
