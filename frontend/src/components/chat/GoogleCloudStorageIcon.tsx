import { SiGooglecloud } from 'react-icons/si';

/** Matches GoogleDriveIcon so the two connectors read as siblings in a menu. */
export default function GoogleCloudStorageIcon({ className }: { className?: string }) {
  return <SiGooglecloud aria-hidden="true" className={className} color="#4285F4" />;
}
