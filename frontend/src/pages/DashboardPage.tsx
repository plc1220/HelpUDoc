import { Link } from 'react-router-dom';
import { LayoutDashboard, Users2, Hammer, CreditCard, MessageCircle, ArrowLeftCircle } from 'lucide-react';

const navItems = [
    { label: 'Dashboard', icon: LayoutDashboard, active: true },
    { label: 'Agents', icon: Users2, active: false },
    { label: 'Tools', icon: Hammer, active: false },
    { label: 'Users', icon: MessageCircle, active: false },
    { label: 'Billing', icon: CreditCard, active: false },
];

const DashboardPage = () => {
    return (
        <div className="flex min-h-screen bg-slate-50">
            <aside className="w-64 border-r border-slate-200 bg-white flex flex-col">
                <div className="p-6 border-b border-slate-200">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Workspace settings</p>
                    <h1 className="text-xl font-semibold text-slate-900 mt-1">Admin Portal</h1>
                </div>
                <nav className="flex-1 p-4 space-y-1">
                    {navItems.map(({ label, icon: Icon, active }) => (
                        <Link
                            key={label}
                            to={label === 'Agents' ? '/settings/agents' : label === 'Dashboard' ? '/settings' : `/settings/${label.toLowerCase()}`}
                            className={`flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium ${active ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'
                                }`}
                        >
                            <Icon size={16} />
                            {label}
                        </Link>
                    ))}
                </nav>
                <div className="p-4 border-t border-slate-200">
                    <Link to="/" className="inline-flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900">
                        <ArrowLeftCircle size={16} />
                        Back to Workspace
                    </Link>
                </div>
            </aside>

            <main className="flex-1 p-10">
                <div className="mb-8">
                    <h2 className="text-2xl font-semibold text-slate-900">Dashboard</h2>
                    <p className="text-slate-600">Overview of your workspace activity.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                        <h3 className="text-lg font-medium text-slate-900 mb-2">Total Agents</h3>
                        <p className="text-3xl font-bold text-slate-900">2</p>
                    </div>
                    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                        <h3 className="text-lg font-medium text-slate-900 mb-2">Active Users</h3>
                        <p className="text-3xl font-bold text-slate-900">1</p>
                    </div>
                    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                        <h3 className="text-lg font-medium text-slate-900 mb-2">Tool Calls</h3>
                        <p className="text-3xl font-bold text-slate-900">124</p>
                    </div>
                </div>
            </main>
        </div>
    );
};

export default DashboardPage;
