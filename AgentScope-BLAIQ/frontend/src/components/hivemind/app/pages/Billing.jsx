import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  CreditCard,
  Check,
  Zap,
  Sparkles,
  ArrowRight,
  Brain,
  Cable,
  Users,
  Shield,
  Clock,
  HardDrive,
  Headphones,
} from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { useApiQuery } from '../shared/hooks';
import apiClient from '../shared/api-client';

// ─── Plan Definitions ────────────────────────────────────────────────────────

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    period: 'forever',
    description: 'For personal projects and experimentation',
    accent: false,
    features: [
      { label: '1,000 memories', icon: Brain },
      { label: '2 MCP connections', icon: Cable },
      { label: '100 searches/day', icon: Zap },
      { label: '7-day retention', icon: Clock },
      { label: 'Community support', icon: Users },
    ],
    limits: {
      memories: 1000,
      connections: 2,
      searches: 100,
    },
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$29',
    period: '/month',
    description: 'For developers and power users',
    accent: true,
    popular: true,
    features: [
      { label: '50,000 memories', icon: Brain },
      { label: 'Unlimited MCP connections', icon: Cable },
      { label: 'Unlimited searches', icon: Zap },
      { label: '1 year retention', icon: Clock },
      { label: 'All workspace connectors', icon: HardDrive },
      { label: 'Priority support', icon: Headphones },
    ],
    limits: {
      memories: 50000,
      connections: null,
      searches: null,
    },
  },
  {
    id: 'team',
    name: 'Team',
    price: '$79',
    period: '/month',
    description: 'For teams building with shared memory',
    accent: false,
    features: [
      { label: '500,000 memories', icon: Brain },
      { label: 'Unlimited connections', icon: Cable },
      { label: 'Unlimited searches', icon: Zap },
      { label: 'Unlimited retention', icon: Clock },
      { label: 'All connectors + SSO', icon: Shield },
      { label: 'Up to 10 team members', icon: Users },
      { label: 'Dedicated support', icon: Headphones },
    ],
    limits: {
      memories: 500000,
      connections: null,
      searches: null,
    },
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    description: 'For organizations with advanced needs',
    accent: false,
    features: [
      { label: 'Unlimited memories', icon: Brain },
      { label: 'Unlimited everything', icon: Zap },
      { label: 'Custom retention policies', icon: Clock },
      { label: 'SAML/SSO + SCIM', icon: Shield },
      { label: 'Dedicated infrastructure', icon: HardDrive },
      { label: 'SLA guarantee', icon: Headphones },
      { label: 'Unlimited team members', icon: Users },
    ],
    limits: {
      memories: null,
      connections: null,
      searches: null,
    },
  },
];

// ─── Usage Meter ─────────────────────────────────────────────────────────────

function UsageMeter({ label, used, limit, icon: Icon }) {
  const isUnlimited = !limit;
  const pct = isUnlimited ? 0 : Math.min((used / limit) * 100, 100);
  const isNearLimit = pct > 80;

  return (
    <div className="bg-white border border-[#e3e0db] rounded-xl p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon size={14} className="text-[#a3a3a3]" />
          <span className="text-[#525252] text-[11px] font-['Space_Grotesk'] uppercase tracking-wider">
            {label}
          </span>
        </div>
        <span className="text-[#0a0a0a] text-sm font-mono font-semibold">
          {used?.toLocaleString() || 0}
          <span className="text-[#d4d0ca]">
            {isUnlimited ? ' / Unlimited' : ` / ${limit?.toLocaleString()}`}
          </span>
        </span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-[#e3e0db] overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: isUnlimited ? '0%' : `${pct}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          className={`h-full rounded-full ${
            isNearLimit ? 'bg-amber-400' : 'bg-[#117dff]'
          }`}
        />
      </div>
      {isNearLimit && (
        <p className="text-amber-400/70 text-[10px] font-['Space_Grotesk'] mt-1.5">
          {pct >= 100 ? 'Limit reached \u2014 upgrade to continue' : 'Approaching limit'}
        </p>
      )}
    </div>
  );
}

// ─── Plan Card ───────────────────────────────────────────────────────────────

function PlanCard({ plan, currentPlan, onSelect }) {
  const isCurrent = currentPlan === plan.id;
  const isEnterprise = plan.id === 'enterprise';

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className={`relative rounded-xl border p-5 flex flex-col transition-all ${
        plan.accent
          ? 'bg-[#117dff]/[0.04] border-[#117dff]/20 shadow-[0_0_30px_rgba(17,125,255,0.06)]'
          : 'bg-white border-[#e3e0db] hover:border-[#d4d0ca] shadow-[0_1px_3px_rgba(0,0,0,0.04)]'
      }`}
    >
      {/* Popular badge */}
      {plan.popular && (
        <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
          <span className="inline-flex items-center gap-1 px-3 py-0.5 rounded-full text-[10px] font-semibold font-['Space_Grotesk'] bg-[#117dff] text-white uppercase tracking-wider">
            <Sparkles size={10} />
            Most Popular
          </span>
        </div>
      )}

      {/* Plan Name */}
      <div className="mb-4">
        <h3 className="text-[#0a0a0a] text-base font-semibold font-['Space_Grotesk'] mb-1">
          {plan.name}
        </h3>
        <p className="text-[#a3a3a3] text-[12px] font-['Space_Grotesk']">
          {plan.description}
        </p>
      </div>

      {/* Price */}
      <div className="flex items-baseline gap-1 mb-5">
        <span className="text-[#0a0a0a] text-3xl font-bold font-mono">
          {plan.price}
        </span>
        {plan.period && (
          <span className="text-[#a3a3a3] text-sm font-['Space_Grotesk']">
            {plan.period}
          </span>
        )}
      </div>

      {/* Features */}
      <div className="space-y-2.5 mb-6 flex-1">
        {plan.features.map((feature, i) => (
          <div key={i} className="flex items-center gap-2.5">
            <Check size={14} className={plan.accent ? 'text-[#117dff]' : 'text-[#a3a3a3]'} />
            <span className="text-[#525252] text-[12px] font-['Space_Grotesk']">
              {feature.label}
            </span>
          </div>
        ))}
      </div>

      {/* CTA */}
      {isCurrent ? (
        <div className="text-center py-2.5 rounded-lg bg-[#f3f1ec] border border-[#e3e0db] text-[#525252] text-[12px] font-semibold font-['Space_Grotesk']">
          Current Plan
        </div>
      ) : isEnterprise ? (
        <button className="flex items-center justify-center gap-2 py-2.5 rounded-lg bg-[#f3f1ec] border border-[#d4d0ca] text-[#0a0a0a] text-[12px] font-semibold font-['Space_Grotesk'] hover:bg-[#eae7e1] transition-all">
          Contact Sales
          <ArrowRight size={13} />
        </button>
      ) : (
        <button
          onClick={() => onSelect(plan.id)}
          className={`flex items-center justify-center gap-2 py-2.5 rounded-lg text-[12px] font-semibold font-['Space_Grotesk'] transition-all ${
            plan.accent
              ? 'bg-[#117dff] text-white hover:bg-[#0066e0]'
              : 'bg-[#f3f1ec] border border-[#d4d0ca] text-[#0a0a0a] hover:bg-[#eae7e1]'
          }`}
        >
          {plan.accent ? 'Upgrade to Pro' : `Switch to ${plan.name}`}
          <ArrowRight size={13} />
        </button>
      )}
    </motion.div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function Billing() {
  const { org } = useAuth();
  const [billingCycle, setBillingCycle] = useState('monthly');
  const currentPlan = 'free'; // TODO: derive from bootstrap/org data

  const { data: profile } = useApiQuery(
    () => apiClient.getProfile().catch(() => null),
    [],
  );

  const memoryCount = profile?.memory_count || 0;
  const currentPlanDef = PLANS.find((p) => p.id === currentPlan);

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Current Plan Overview */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white border border-[#e3e0db] rounded-xl p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
      >
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#117dff]/10 border border-[#117dff]/20 flex items-center justify-center">
              <CreditCard size={18} className="text-[#117dff]" />
            </div>
            <div>
              <h2 className="text-[#0a0a0a] text-base font-semibold font-['Space_Grotesk']">
                Current Plan
              </h2>
              <p className="text-[#a3a3a3] text-[12px] font-['Space_Grotesk']">
                {org?.name || 'Your workspace'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[#0a0a0a] text-lg font-bold font-['Space_Grotesk']">
              {currentPlanDef?.name}
            </span>
            <span className="text-[10px] font-mono bg-[#f3f1ec] text-[#525252] px-2 py-0.5 rounded uppercase">
              {currentPlan}
            </span>
          </div>
        </div>

        {/* Usage Meters */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <UsageMeter
            label="Memories"
            used={memoryCount}
            limit={currentPlanDef?.limits.memories}
            icon={Brain}
          />
          <UsageMeter
            label="Connections"
            used={3}
            limit={currentPlanDef?.limits.connections}
            icon={Cable}
          />
          <UsageMeter
            label="Searches Today"
            used={0}
            limit={currentPlanDef?.limits.searches}
            icon={Zap}
          />
        </div>
      </motion.div>

      {/* Billing Cycle Toggle */}
      <div className="flex items-center justify-center gap-1 bg-white border border-[#e3e0db] rounded-lg p-1 w-fit mx-auto">
        <button
          onClick={() => setBillingCycle('monthly')}
          className={`px-4 py-1.5 rounded-md text-[12px] font-medium font-['Space_Grotesk'] transition-all ${
            billingCycle === 'monthly'
              ? 'bg-[#f3f1ec] text-[#0a0a0a]'
              : 'text-[#525252] hover:text-[#525252]'
          }`}
        >
          Monthly
        </button>
        <button
          onClick={() => setBillingCycle('annual')}
          className={`px-4 py-1.5 rounded-md text-[12px] font-medium font-['Space_Grotesk'] transition-all flex items-center gap-1.5 ${
            billingCycle === 'annual'
              ? 'bg-[#f3f1ec] text-[#0a0a0a]'
              : 'text-[#525252] hover:text-[#525252]'
          }`}
        >
          Annual
          <span className="text-[9px] font-mono bg-[#117dff]/10 text-[#117dff] px-1.5 py-0.5 rounded">
            -20%
          </span>
        </button>
      </div>

      {/* Plan Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {PLANS.map((plan, i) => (
          <PlanCard
            key={plan.id}
            plan={{
              ...plan,
              price: billingCycle === 'annual' && plan.price !== '$0' && plan.price !== 'Custom'
                ? `$${Math.round(parseInt(plan.price.replace('$', '')) * 0.8)}`
                : plan.price,
            }}
            currentPlan={currentPlan}
            onSelect={(id) => console.log('Upgrade to:', id)}
          />
        ))}
      </div>

      {/* FAQ Section */}
      <div className="bg-white border border-[#e3e0db] rounded-xl p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <h3 className="text-[#0a0a0a] text-sm font-semibold font-['Space_Grotesk'] mb-4">
          Frequently Asked Questions
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            {
              q: 'What counts as a memory?',
              a: 'Each piece of information stored \u2014 a note, conversation snippet, code block, or document chunk \u2014 counts as one memory.',
            },
            {
              q: 'Can I switch plans anytime?',
              a: 'Yes. Upgrades take effect immediately. Downgrades apply at the end of your billing cycle.',
            },
            {
              q: 'What happens when I hit my limit?',
              a: 'New memories will be queued but not stored. Existing memories remain accessible. Upgrade to resume ingestion.',
            },
            {
              q: 'Do you offer refunds?',
              a: 'We offer a 14-day money-back guarantee on all paid plans. No questions asked.',
            },
          ].map((faq, i) => (
            <div key={i}>
              <p className="text-[#525252] text-[13px] font-semibold font-['Space_Grotesk'] mb-1">
                {faq.q}
              </p>
              <p className="text-[#a3a3a3] text-[12px] font-['Space_Grotesk'] leading-relaxed">
                {faq.a}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
