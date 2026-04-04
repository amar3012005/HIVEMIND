import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Hexagon, ArrowRight, Building2 } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';

export default function OnboardingFlow() {
  const { user, createOrg } = useAuth();
  const [orgName, setOrgName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!orgName.trim()) return;

    setCreating(true);
    setError(null);
    try {
      await createOrg(orgName.trim());
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#faf9f4] flex items-center justify-center">
      {/* Background */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-[#117dff]/[0.03] blur-[100px]" />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative z-10 w-full max-w-lg mx-4"
      >
        <div className="bg-white backdrop-blur-xl border border-[#e3e0db] rounded-2xl p-8 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-[#117dff]/10 border border-[#117dff]/20 flex items-center justify-center">
              <Hexagon size={22} className="text-[#117dff]" />
            </div>
            <span className="text-[#0a0a0a] text-lg font-bold font-['Space_Grotesk']">HIVEMIND</span>
          </div>

          <h2 className="text-[#0a0a0a] text-2xl font-bold font-['Space_Grotesk'] mb-2">
            Create your workspace
          </h2>
          <p className="text-[#525252] text-sm mb-6">
            Welcome, {user?.display_name || user?.email || 'there'}. Set up your organization to start using HIVEMIND.
          </p>

          <form onSubmit={handleCreate}>
            <label className="block text-[#525252] text-xs font-mono mb-2 uppercase tracking-wider">
              Workspace Name
            </label>
            <div className="relative mb-4">
              <Building2 size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a3a3a3]" />
              <input
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="e.g. Acme Corp"
                className="w-full bg-transparent border border-[#e3e0db] rounded-[6px] py-3 pl-10 pr-4 text-[#0a0a0a] text-sm font-['Space_Grotesk'] placeholder:text-[#d4d0ca] focus:outline-none focus:border-[#117dff]/40 transition-colors"
                autoFocus
              />
            </div>

            {error && (
              <p className="text-[#dc2626] text-xs mb-4 font-mono">{error}</p>
            )}

            <button
              type="submit"
              disabled={!orgName.trim() || creating}
              className="w-full flex items-center justify-center gap-2 bg-[#117dff] hover:bg-[#0e6fe0] disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-[4px] transition-all text-sm font-['Space_Grotesk'] group uppercase tracking-[0.075em]"
            >
              {creating ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  Create Workspace
                  <ArrowRight size={16} className="group-hover:translate-x-0.5 transition-transform" />
                </>
              )}
            </button>
          </form>
        </div>
      </motion.div>
    </div>
  );
}
