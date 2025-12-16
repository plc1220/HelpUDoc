import { CreditCard } from 'lucide-react';
import SettingsShell from '../components/settings/SettingsShell';

const BillingPage = () => {
  return (
    <SettingsShell
      eyebrow="Billing"
      title="Billing"
      description="Manage your subscription, invoices, and payment methods."
    >
      <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex flex-col items-center gap-4 text-center text-slate-600">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-700">
            <CreditCard size={28} />
          </span>
          <div>
            <p className="font-semibold text-slate-900">Billing management is coming soon.</p>
            <p className="mt-2">You&apos;ll be able to manage plans, invoices, and payment methods from here.</p>
          </div>
        </div>
      </div>
    </SettingsShell>
  );
};

export default BillingPage;
