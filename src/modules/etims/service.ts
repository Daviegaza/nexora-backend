import ky from 'ky';
import { env } from '../../lib/env.js';

// KRA eTIMS OSCU/VSCU client — endpoints per TIS v2.0 spec.
// Rules (verified 2026):
//  - `saveItem` MUST succeed for every SKU BEFORE its first sale, else the
//    invoice is rejected at `saveTrnsSalesOsdc` with an unknown-item error.
//  - `saveStockIO` MUST be called on every stock-in event (PO receipt) to
//    preserve the input-VAT claim.
//  - `bhfId` in `saveItem` MUST match `bhfId` in `saveTrnsSalesOsdc`.
//  - Cancellation: no dedicated endpoint. Corrections are credit notes only,
//    max ONE partial credit note per invoice.
//  - VSCU has a 24h offline signing buffer before enforced sync.
//
// Rate limits are NOT published in the spec; production traders report bursty
// throttling at ~5 req/s per branch cert. Callers should exponential-backoff.

const client = ky.create({
  prefixUrl: env.KRA_ETIMS_BASE_URL,
  timeout: 15_000,
  retry: { limit: 2, methods: ['post'], statusCodes: [408, 429, 500, 502, 503, 504] },
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': env.KRA_ETIMS_API_KEY ?? '',
  },
});

// Common wrapper shape returned by KRA endpoints (`resultCd` = '000' on success).
interface EtimsEnvelope<T> {
  resultCd: string;
  resultMsg: string;
  resultDt?: string;
  data?: T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const env_ = await client.post(path, { json: body }).json<EtimsEnvelope<T>>();
  if (env_.resultCd !== '000') {
    throw new EtimsError(env_.resultCd, env_.resultMsg, path);
  }
  return env_.data ?? ({} as T);
}

export class EtimsError extends Error {
  code = 'ETIMS_ERROR';
  constructor(
    public resultCd: string,
    message: string,
    public endpoint: string,
  ) {
    super(`eTIMS ${endpoint} failed [${resultCd}]: ${message}`);
  }
}

// ── selectInitOsdcInfo — device init at boot (VSCU) ──────────────────────
export interface OsdcInit {
  tin: string;
  bhfId: string;
  dvcSrlNo: string; // device serial (VSCU: random per branch)
}
export async function selectInitOsdcInfo(p: OsdcInit) {
  return post<{ info: Record<string, unknown> }>('selectInitOsdcInfo', p);
}

// ── saveItem — SKU registration (MUST run before first sale) ─────────────
export interface SaveItemInput {
  tin: string;
  bhfId: string;
  itemCd: string; // Nexora product.sku
  itemClsCd: string; // KRA classification code
  itemTyCd?: string; // '1' = raw, '2' = finished, '3' = service
  itemNm: string;
  itemStdNm?: string;
  orgnNatCd?: string; // 'KE'
  pkgUnitCd?: string; // 'NT' (each)
  qtyUnitCd?: string; // 'U' (unit)
  taxTyCd: 'A' | 'B' | 'C' | 'D' | 'E'; // A=exempt,B=16%,C=0%,D=8%,E=non-VAT
  bcd?: string; // barcode
  dftPrc: number; // default price (VAT-inclusive)
  isrcAplcbYn?: 'Y' | 'N';
  useYn?: 'Y' | 'N';
  regrId: string; // registrar user id
  regrNm: string;
  modrId: string;
  modrNm: string;
}
export async function saveItem(p: SaveItemInput) {
  return post<{ itemCd: string }>('saveItem', p);
}

// ── saveStockIO — stock in/out (PO receipts + adjustments) ───────────────
export interface StockIoInput {
  tin: string;
  bhfId: string;
  sarNo: number; // KRA stock adjustment reference
  orgSarNo?: number;
  regTyCd: 'A' | 'M'; // Automatic vs Manual
  custTin?: string;
  custNm?: string;
  custBhfId?: string;
  sarTyCd: '01' | '02' | '03' | '04' | '05' | '06' | '11' | '12' | '13' | '14' | '15' | '16';
  // '02' = purchase, '11' = sale, '06' = adjustment out, '05' = adjustment in
  ocrnDt: string; // YYYYMMDD
  totItemCnt: number;
  totTaxblAmt: number;
  totTaxAmt: number;
  totAmt: number;
  remark?: string;
  regrId: string;
  regrNm: string;
  modrId: string;
  modrNm: string;
  itemList: Array<{
    itemSeq: number;
    itemCd: string;
    itemClsCd: string;
    itemNm: string;
    pkgUnitCd: string;
    pkg: number;
    qtyUnitCd: string;
    qty: number;
    prc: number;
    splyAmt: number;
    totDcAmt: number;
    taxblAmt: number;
    taxTyCd: string;
    taxAmt: number;
    totAmt: number;
  }>;
}
export async function saveStockIO(p: StockIoInput) {
  return post<{ sarNo: number }>('saveStockIO', p);
}

// ── saveBhfCustomer — customer register ──────────────────────────────────
export interface SaveCustomerInput {
  tin: string;
  bhfId: string;
  custNo: string;
  custTin?: string;
  custNm: string;
  adrs?: string;
  telNo?: string;
  email?: string;
  faxNo?: string;
  useYn?: 'Y' | 'N';
  remark?: string;
  regrNm: string;
  regrId: string;
  modrNm: string;
  modrId: string;
}
export async function saveBhfCustomer(p: SaveCustomerInput) {
  return post<{ custNo: string }>('saveBhfCustomer', p);
}

// ── saveTrnsSalesOsdc — the actual sale/invoice ──────────────────────────
export interface SaveTrnsSalesInput {
  tin: string;
  bhfId: string;
  invcNo: number; // running counter, per branch
  orgInvcNo?: number; // for credit notes: original invoice
  custTin?: string;
  custNm?: string;
  salesTyCd: 'N' | 'C' | 'P'; // N = normal, C = copy, P = proforma
  rcptTyCd: 'S' | 'R' | 'T'; // S = sale, R = refund, T = training
  pmtTyCd: '01' | '02' | '03' | '04' | '05' | '06' | '07';
  // '01'=cash, '02'=credit, '03'=cash/credit, '04'=bank check,
  // '05'=debit/credit card, '06'=mobile money, '07'=other
  salesSttsCd: '01' | '02' | '03' | '04' | '05'; // 02 = approved
  cfmDt: string; // YYYYMMDDHHmmss
  salesDt: string; // YYYYMMDD
  stockRlsDt?: string;
  cnclReqDt?: string;
  cnclDt?: string;
  rfdDt?: string;
  rfdRsnCd?: string;
  totItemCnt: number;
  taxblAmtA: number;
  taxblAmtB: number;
  taxblAmtC: number;
  taxblAmtD: number;
  taxblAmtE: number;
  taxRtA: number; // 0
  taxRtB: number; // 16
  taxRtC: number; // 0
  taxRtD: number; // 8
  taxRtE: number; // 0
  taxAmtA: number;
  taxAmtB: number;
  taxAmtC: number;
  taxAmtD: number;
  taxAmtE: number;
  totTaxblAmt: number;
  totTaxAmt: number;
  totAmt: number;
  prchrAcptcYn: 'Y' | 'N';
  remark?: string;
  regrId: string;
  regrNm: string;
  modrId: string;
  modrNm: string;
  receipt?: {
    custTin?: string;
    custMblNo?: string;
    rptNo?: number;
    trdeNm?: string;
    adrs?: string;
    topMsg?: string;
    btmMsg?: string;
    prchrAcptcYn: 'Y' | 'N';
  };
  itemList: Array<{
    itemSeq: number;
    itemCd: string;
    itemClsCd: string;
    itemNm: string;
    bcd?: string;
    pkgUnitCd: string;
    pkg: number;
    qtyUnitCd: string;
    qty: number;
    prc: number;
    splyAmt: number;
    dcRt: number;
    dcAmt: number;
    isrccCd?: string;
    isrccNm?: string;
    isrcRt?: number;
    isrcAmt?: number;
    taxTyCd: 'A' | 'B' | 'C' | 'D' | 'E';
    taxblAmt: number;
    taxAmt: number;
    totAmt: number;
  }>;
}
export interface SaveTrnsSalesResult {
  curRcptNo: number;
  totRcptNo: number;
  intrlData: string; // KRA-signed internal blob
  rcptSign: string; // KRA signature (for QR)
  sdcDateTime: string;
  sdcId: string;
  mrcNo: string;
}
export async function saveTrnsSalesOsdc(p: SaveTrnsSalesInput) {
  return post<SaveTrnsSalesResult>('saveTrnsSalesOsdc', p);
}

// KRA QR verification URL — appears on printed receipt.
export function etimsQrUrl(r: SaveTrnsSalesResult, tin: string): string {
  // Format: https://etims-sbx.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?
  //         Data=<tin>{internalData}{signature}
  const base =
    env.KRA_ETIMS_QR_BASE ??
    'https://etims-sbx.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData';
  return `${base}?Data=${tin}${r.intrlData}${r.rcptSign}`;
}

// ── Legacy shim — kept for backward compat with old transaction path ─────
// Old code called `fileEtimsInvoice({ tin, bhfId, invoiceNo, items, total, vat })`.
// Route via `saveTrnsSalesOsdc` with sensible defaults. Marked deprecated —
// prefer building a full `SaveTrnsSalesInput` in the worker.
export interface EtimsInvoicePayload {
  tin: string;
  bhfId: string;
  invoiceNo: string;
  items: { name: string; quantity: number; price: number; tax: number }[];
  total: number;
  vat: number;
}
/** @deprecated use `saveTrnsSalesOsdc` directly from the etims-filer worker. */
export async function fileEtimsInvoice(p: EtimsInvoicePayload): Promise<{
  rcptNo: string;
  qrCode: string;
  sdcId: string;
  internalData: string;
  signature: string;
}> {
  // Minimal adapter — enough to unblock the type surface; the real payload
  // build lives in the worker.
  const now = new Date();
  const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const cfm = yyyymmdd + now.toTimeString().slice(0, 8).replace(/:/g, '');
  const r = await saveTrnsSalesOsdc({
    tin: p.tin,
    bhfId: p.bhfId,
    invcNo: Date.now() % 1_000_000,
    salesTyCd: 'N',
    rcptTyCd: 'S',
    pmtTyCd: '01',
    salesSttsCd: '02',
    cfmDt: cfm,
    salesDt: yyyymmdd,
    totItemCnt: p.items.length,
    taxblAmtA: 0,
    taxblAmtB: p.total - p.vat,
    taxblAmtC: 0,
    taxblAmtD: 0,
    taxblAmtE: 0,
    taxRtA: 0,
    taxRtB: 16,
    taxRtC: 0,
    taxRtD: 8,
    taxRtE: 0,
    taxAmtA: 0,
    taxAmtB: p.vat,
    taxAmtC: 0,
    taxAmtD: 0,
    taxAmtE: 0,
    totTaxblAmt: p.total - p.vat,
    totTaxAmt: p.vat,
    totAmt: p.total,
    prchrAcptcYn: 'N',
    regrId: 'system',
    regrNm: 'system',
    modrId: 'system',
    modrNm: 'system',
    itemList: p.items.map((i, seq) => ({
      itemSeq: seq + 1,
      itemCd: `SKU-${seq + 1}`,
      itemClsCd: '5059690800',
      itemNm: i.name,
      pkgUnitCd: 'NT',
      pkg: 1,
      qtyUnitCd: 'U',
      qty: i.quantity,
      prc: i.price,
      splyAmt: i.price * i.quantity,
      dcRt: 0,
      dcAmt: 0,
      taxTyCd: 'B',
      taxblAmt: i.price * i.quantity - i.tax,
      taxAmt: i.tax,
      totAmt: i.price * i.quantity,
    })),
  });
  return {
    rcptNo: String(r.curRcptNo),
    qrCode: etimsQrUrl(r, p.tin),
    sdcId: r.sdcId,
    internalData: r.intrlData,
    signature: r.rcptSign,
  };
}

export async function cancelEtimsInvoice(_invoiceNo: string) {
  // Per KRA v2.0: no direct cancel endpoint. Corrections via credit note only.
  // Caller must build a `saveTrnsSalesOsdc` with `rcptTyCd: 'R'` (refund) and
  // `orgInvcNo` set to the original invoice number.
  throw new EtimsError(
    'NOT_SUPPORTED',
    'eTIMS does not support direct cancellation; issue a credit note (rcptTyCd=R).',
    'cancel',
  );
}
