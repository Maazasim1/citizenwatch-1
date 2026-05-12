'use client';

import { useState } from 'react';
import { ShieldAlert, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function LoginPage() {
    const { login, register, verifyOtp } = useAuth();
    const router = useRouter();
    const [tab, setTab] = useState<'login' | 'register'>('login');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [registerRole, setRegisterRole] = useState<'CITIZEN' | 'MODERATOR' | 'LAW_ENFORCEMENT'>('CITIZEN');
    const [showPassword, setShowPassword] = useState(false);
    
    // OTP State
    const [otpStep, setOtpStep] = useState(false);
    const [otpCode, setOtpCode] = useState('');
    const [userId, setUserId] = useState('');

    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        if (otpStep) {
            const result = await verifyOtp({ userId, otpCode });
            setLoading(false);
            if (result.error) {
                setError(result.error);
            } else {
                router.push('/');
            }
            return;
        }

        const fn = tab === 'login' ? login : register;
        const result = await fn(
            tab === 'register'
                ? { email, password, role: registerRole }
                : { email, password }
        );
        setLoading(false);
        if (result.error) {
            setError(result.error);
        } else if (result.requiresOtp) {
            setUserId(result.userId!);
            setOtpStep(true);
        } else {
            router.push('/');
        }
    };

    return (
        <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4 font-sans">
            {/* Background pattern */}
            <div
                className="fixed inset-0 opacity-[0.03]"
                style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, white 1px, transparent 0)', backgroundSize: '32px 32px' }}
            />

            <div className="w-full max-w-sm relative z-10">
                {/* Logo */}
                <div className="text-center mb-8">
                    <div className="w-14 h-14 rounded-2xl bg-rose-600/10 border border-rose-500/20 flex items-center justify-center mx-auto mb-4">
                        <ShieldAlert className="w-7 h-7 text-rose-500" />
                    </div>
                    <h1 className="text-2xl font-bold text-slate-100 tracking-tight">
                        Citizen<span className="text-rose-500">watch</span>
                    </h1>
                    <p className="text-slate-400 text-sm mt-1">Crime Intelligence & Community Safety</p>
                </div>

                {/* Card */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
                    {/* Tabs */}
                    <div className="flex gap-1 bg-slate-950 rounded-xl p-1 mb-6">
                        <button
                            onClick={() => { setTab('login'); setError(''); }}
                            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${tab === 'login' ? 'bg-slate-800 text-slate-100 shadow-sm' : 'text-slate-500 hover:text-slate-400'}`}
                        >
                            Sign In
                        </button>
                        <button
                            onClick={() => { setTab('register'); setError(''); }}
                            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${tab === 'register' ? 'bg-slate-800 text-slate-100 shadow-sm' : 'text-slate-500 hover:text-slate-400'}`}
                        >
                            Register
                        </button>
                    </div>

                    {otpStep ? (
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div>
                                <label className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1.5 block text-center">
                                    Enter 6-Digit Verification Code
                                </label>
                                <p className="text-center text-sm text-slate-500 mb-4 cursor-pointer" onClick={() => setOtpStep(false)}>
                                    Sent to {email}. <span className="text-indigo-400 hover:underline">Change?</span>
                                </p>
                                <input
                                    type="text"
                                    maxLength={6}
                                    value={otpCode}
                                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                                    placeholder="000000"
                                    required
                                    className="w-full text-center text-2xl tracking-[0.5em] bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-700 focus:outline-none focus:border-indigo-500 transition-colors"
                                />
                            </div>

                            {error && (
                                <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-xl px-4 py-3">
                                    {error}
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={loading || otpCode.length !== 6}
                                className="w-full bg-indigo-600 hover:bg-indigo-500 text-white py-3 rounded-xl font-semibold text-sm transition-all active:scale-95 shadow-lg shadow-indigo-600/20 flex items-center justify-center gap-2 disabled:opacity-60"
                            >
                                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                                Verify Account
                            </button>
                        </form>

                    ) : (

                    <form onSubmit={handleSubmit} className="space-y-4">
                        {/* Email */}
                        <div>
                            <label className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1.5 block">
                                Email Address
                            </label>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="you@example.com"
                                required
                                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
                            />
                        </div>

                        {/* Password */}
                        <div>
                            <label className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1.5 block">
                                Password
                            </label>
                            <div className="relative">
                                <input
                                    type={showPassword ? 'text' : 'password'}
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder="••••••••"
                                    required
                                    minLength={8}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 pr-11 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                                >
                                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                        </div>

                        {tab === 'register' && (
                            <div>
                                <label className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1.5 block">
                                    Register As
                                </label>
                                <select
                                    value={registerRole}
                                    onChange={(e) => setRegisterRole(e.target.value as 'CITIZEN' | 'MODERATOR' | 'LAW_ENFORCEMENT')}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 transition-colors"
                                >
                                    <option value="CITIZEN">Citizen</option>
                                    <option value="MODERATOR">Moderator</option>
                                    <option value="LAW_ENFORCEMENT">Police / Law Enforcement</option>
                                </select>
                            </div>
                        )}

                        {/* Error message */}
                        {error && (
                            <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-xl px-4 py-3">
                                {error}
                            </div>
                        )}

                        {/* Submit */}
                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full bg-rose-600 hover:bg-rose-500 text-white py-3 rounded-xl font-semibold text-sm transition-all active:scale-95 shadow-lg shadow-rose-600/20 flex items-center justify-center gap-2 disabled:opacity-60 mt-2"
                        >
                            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                            {tab === 'login' ? 'Sign In' : 'Create Account'}
                        </button>
                    </form>
                    )}

                    {/* Divider */}
                    <div className="flex items-center gap-3 my-5">
                        <div className="flex-1 h-px bg-slate-800" />
                        <span className="text-xs text-slate-600">or</span>
                        <div className="flex-1 h-px bg-slate-800" />
                    </div>

                    {/* Anonymous report shortcut */}
                    <Link
                        href="/report"
                        className="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white py-3 rounded-xl font-medium text-sm transition-all"
                    >
                        Submit an Anonymous Report
                    </Link>
                </div>

                {/* Role hint */}
                <div className="mt-5 bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                    <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mb-2">Test Accounts</p>
                    <div className="space-y-1.5 text-xs text-slate-400 font-mono">
                        <p><span className="text-slate-500">Citizen:</span> fatima@example.com / password123</p>
                        <p><span className="text-slate-500">Moderator:</span> sana.mod@example.com / password123</p>
                        <p><span className="text-slate-500">Inspector:</span> khalid.inspector@sindhpolice.gov.pk / password123</p>
                    </div>
                </div>
            </div>
        </div>
    );
}
