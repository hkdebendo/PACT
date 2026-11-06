import { Suspense } from 'react';
import { PactRoom } from './pact-room';

export default async function PactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The PayPal client id is a public identifier (it is part of every PayPal checkout page), but it
  // still comes from .env.local rather than the repo. Only used in sandbox mode.
  const paypalClientId = process.env.PAYPAL_CLIENT_ID || null;
  return (
    <Suspense>
      <PactRoom id={id} paypalClientId={paypalClientId} />
    </Suspense>
  );
}
