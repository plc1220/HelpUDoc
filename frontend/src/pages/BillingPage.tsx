import { CreditCard } from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';
import { SettingsEmptyState, SettingsSurface } from '../components/settings/SettingsScaffold';

const BillingPage = () => {
  return (
    <SettingsShell
      eyebrow="Billing"
      title="Billing"
      description="Manage your subscription, invoices, and payment methods."
    >
      <SettingsSurface>
        <SettingsEmptyState
          title="Billing management is coming soon"
          description="You’ll be able to manage plans, invoices, and payment methods from this page once billing workflows are connected."
          icon={CreditCard}
        />
      </SettingsSurface>
    </SettingsShell>
  );
};

export default BillingPage;
