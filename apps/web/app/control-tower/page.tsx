import type { Metadata } from 'next';
import { ControlTower } from './control-tower';

export const metadata: Metadata = { title: 'Control Tower' };

export default function ControlTowerPage() {
  // The licence key is read on the server from .env.local and handed to AgStudioProvider. Without
  // it Studio still renders, with its trial watermark/console notice.
  const licenseKey = process.env.AG_STUDIO_LICENSE_KEY || undefined;
  // The PACT Auditor works in live mode with a Meta key, or in replay mode from recorded answers.
  const aiEnabled = !!process.env.META_API_KEY || process.env.LLM_MODE === 'replay';
  return <ControlTower licenseKey={licenseKey} aiEnabled={aiEnabled} />;
}
