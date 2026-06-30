import ky from 'ky';
import { env } from '../../lib/env.js';

const client = ky.create({
  prefixUrl: env.KRA_ETIMS_BASE_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json', 'X-API-Key': env.KRA_ETIMS_API_KEY ?? '' },
});

export interface EtimsInvoicePayload {
  tin: string; bhfId: string; invoiceNo: string;
  customerName?: string; customerTin?: string;
  items: { name: string; quantity: number; price: number; tax: number }[];
  total: number; vat: number;
}

export async function fileEtimsInvoice(payload: EtimsInvoicePayload) {
  // Production: POST to https://etims-api-sbx.kra.go.ke/oscu/v1/invoice
  // Returns { rcptNo, qrCode, sdcId, internalData, signature }
  const res = await client.post('oscu/v1/invoice', { json: payload }).json<{
    rcptNo: string; qrCode: string; sdcId: string; internalData: string; signature: string;
  }>();
  return res;
}

export async function cancelEtimsInvoice(invoiceNo: string) {
  return client.post('oscu/v1/invoice/cancel', { json: { invoiceNo } }).json();
}
