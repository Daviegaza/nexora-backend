import ky from 'ky';
import { env } from '../../lib/env.js';

const baseUrl = env.MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

async function getAccessToken(): Promise<string> {
  const credentials = Buffer.from(`${env.MPESA_CONSUMER_KEY}:${env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await ky.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  }).json<{ access_token: string; expires_in: string }>();
  return res.access_token;
}

export interface StkPushArgs {
  phone: string;       // 2547XXXXXXXX
  amount: number;
  accountRef: string;
  description: string;
  callbackUrl: string;
}

export async function stkPush(a: StkPushArgs) {
  const token = await getAccessToken();
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const password = Buffer.from(`${env.MPESA_SHORTCODE}${env.MPESA_PASSKEY}${timestamp}`).toString('base64');
  return ky.post(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
    headers: { Authorization: `Bearer ${token}` },
    json: {
      BusinessShortCode: env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(a.amount),
      PartyA: a.phone,
      PartyB: env.MPESA_SHORTCODE,
      PhoneNumber: a.phone,
      CallBackURL: a.callbackUrl,
      AccountReference: a.accountRef,
      TransactionDesc: a.description,
    },
  }).json<{ MerchantRequestID: string; CheckoutRequestID: string; ResponseCode: string; ResponseDescription: string; CustomerMessage: string }>();
}
