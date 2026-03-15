import React, { useState } from 'react';
import { 
  Key, 
  ChevronDown, 
  ChevronLeft, 
  ChevronRight, 
  Database, 
  Bot, 
  Code2, 
  MessageSquare, 
  ShieldCheck,
  Menu,
  Copy
} from 'lucide-react';

// --- Components ---

const TopBanner = () => (
  <div className="bg-gradient-to-r from-[#22c55e] via-[#4ade80] to-[#22c55e] text-black text-[13px] font-medium py-[6px] flex justify-center items-center gap-1.5 w-full z-50 relative">
    <span>HIVEMIND: The Sovereign Enterprise Memory Engine</span>
    <span className="opacity-40 mx-1">|</span>
    <span className="hover:underline cursor-pointer flex items-center">Read the report <span className="ml-1 leading-none mb-0.5">›</span></span>
  </div>
);

const Navbar = () => (
  <nav className="w-full flex items-center justify-between px-6 py-4 border-b border-[#ffffff10] bg-[#0a0a0a]/80 backdrop-blur-md sticky top-0 z-40">
    <div className="flex items-center gap-8">
      {/* Logo */}
      <div className="flex items-center gap-2 cursor-pointer">
        <div className="w-6 h-6 flex flex-wrap gap-[2px] items-center justify-center">
            {/* Simple representation of Cartesia dot logo */}
            {[...Array(9)].map((_, i) => (
                <div key={i} className={`w-1.5 h-1.5 rounded-full ${i === 4 ? 'bg-transparent' : 'bg-[#4ade80]'}`} />
            ))}
        </div>
        <span className="text-white font-semibold text-xl tracking-tight">HIVEMIND</span>
      </div>

      {/* Links - Desktop */}
      <div className="hidden md:flex items-center gap-6 text-[14px] text-[#a1a1aa] font-medium">
        <a href="#" className="hover:text-white transition-colors flex items-center gap-1.5">
          Platform <span className="text-[#4ade80] text-[10px] tracking-wider uppercase border border-[#4ade80]/30 bg-[#4ade80]/10 px-1.5 py-0.5 rounded-sm">V1</span>
        </a>
        <a href="#" className="hover:text-white transition-colors">Integrations</a>
        <a href="#" className="hover:text-white transition-colors">Security</a>
        <a href="#" className="hover:text-white transition-colors">Docs</a>
        <a href="#" className="hover:text-white transition-colors">Pricing</a>
      </div>
    </div>

    {/* Actions */}
    <div className="hidden md:flex items-center gap-4 text-[14px] font-medium">
      <button className="text-[#a1a1aa] hover:text-white transition-colors">Contact sales</button>
      <button className="text-white border border-[#ffffff20] hover:bg-[#ffffff10] px-4 py-1.5 rounded-full transition-colors">Sign in</button>
      <button className="bg-white text-black px-4 py-1.5 rounded-full hover:bg-gray-100 transition-colors">Generate Key</button>
    </div>
    
    <div className="md:hidden text-white">
        <Menu size={24} />
    </div>
  </nav>
);

const Hero = () => (
  <section className="relative w-full pt-24 pb-16 px-6 flex flex-col items-center justify-center text-center overflow-hidden">
    {/* Background Glow */}
    <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[800px] h-[500px] bg-[#4ade80] opacity-[0.07] blur-[120px] rounded-[100%] pointer-events-none" />

    <div className="z-10 max-w-4xl mx-auto flex flex-col items-center">
      <h2 className="text-[#4ade80] text-[13px] font-bold tracking-widest uppercase mb-6 drop-shadow-sm">The Contextual Spine</h2>
      <h1 className="text-white text-5xl md:text-[72px] leading-[1.05] font-medium tracking-tight mb-6">
        Stop re-explaining your<br />business to your AI
      </h1>
      <p className="text-[#a1a1aa] text-lg md:text-xl max-w-2xl mb-10 font-normal">
        HIVEMIND gives your LLMs a persistent, sovereign,<br className="hidden md:block"/> and structured memory that lives across all your tools.
      </p>
      
      <div className="flex items-center gap-4 mb-20">
        <button className="bg-white text-black px-6 py-3 rounded-full font-medium hover:bg-gray-100 transition-colors">
          Get Ultimate API Key
        </button>
        <button className="text-white border border-[#ffffff20] px-6 py-3 rounded-full font-medium hover:bg-[#ffffff05] transition-colors">
          Deploy On-Premise
        </button>
      </div>

      {/* Interactive Mockup Box */}
      <div className="relative w-full max-w-3xl aspect-[16/9] md:aspect-auto md:h-[340px] rounded-2xl border border-[#ffffff15] bg-[#141414]/80 backdrop-blur-xl flex flex-col justify-between overflow-hidden text-left shadow-2xl shadow-black/50">
        
        {/* Decorative subtle gradients behind the box */}
        <div className="absolute -left-32 top-0 w-64 h-full bg-gradient-to-r from-[#86efac]/20 to-transparent blur-3xl pointer-events-none" />
        <div className="absolute -right-32 top-0 w-64 h-full bg-gradient-to-l from-[#86efac]/20 to-transparent blur-3xl pointer-events-none" />

        {/* Top Content */}
        <div className="p-8 pb-4 relative z-10">
          <p className="text-[#e5e5e5] text-xl md:text-[22px] leading-relaxed font-sans">
            <span className="text-[#4ade80] font-mono text-lg bg-[#4ade80]/10 px-1 py-0.5 rounded">{'[System]'}</span>
            {' '}Identity verified via ZITADEL.{' '}
            <span className="text-[#4ade80] font-mono text-lg bg-[#4ade80]/10 px-1 py-0.5 rounded">{'<MemoryLoaded />'}</span>
            {' '}Context for "Project X" retrieved. Your preferred coding style and previous architecture decisions are now active.
          </p>
        </div>

        {/* Bottom Content Area */}
        <div className="p-8 pt-0 flex flex-col gap-8 relative z-10 mt-auto">
          {/* Pills */}
          <div className="flex flex-wrap items-center gap-3">
            {[
              { icon: Bot, label: 'ChatGPT Actions', active: true },
              { icon: Database, label: 'Claude Connectors' },
              { icon: Code2, label: 'Cursor MCP' },
              { icon: MessageSquare, label: 'Slack Webhooks' },
              { icon: ShieldCheck, label: 'ZITADEL Auth' },
            ].map((pill, i) => (
              <button 
                key={i} 
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors border
                  ${pill.active 
                    ? 'bg-[#2a2a2a] text-white border-[#444]' 
                    : 'bg-transparent text-[#888] border-[#333] hover:text-white hover:border-[#444]'
                  }`}
              >
                <pill.icon size={14} className={pill.active ? "text-[#888]" : "text-[#666]"} />
                {pill.label}
              </button>
            ))}
          </div>

          {/* Controls */}
          <div className="flex items-center justify-between border-t border-[#ffffff10] pt-6">
            <button className="flex items-center gap-2 text-white bg-[#ffffff08] hover:bg-[#ffffff10] border border-[#ffffff10] px-3 py-1.5 rounded-lg text-sm transition-colors font-mono text-xs text-[#a1a1aa]">
               <ShieldCheck size={14} className="text-[#4ade80]" />
               Role: Enterprise Admin
               <ChevronDown size={14} className="text-[#888] ml-1" />
            </button>

            <button className="flex items-center gap-2 bg-white text-black px-6 py-2.5 rounded-full font-medium hover:bg-gray-100 transition-colors shadow-[0_0_20px_rgba(255,255,255,0.2)]">
               <Key size={16} fill="currentColor" />
               Copy API Key
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
);

const LogoCloud = () => (
  <section className="w-full border-y border-[#ffffff10] bg-[#0a0a0a] py-8 overflow-hidden">
    <div className="max-w-7xl mx-auto px-6 flex flex-wrap justify-between items-center gap-8 md:gap-16 opacity-60 grayscale hover:grayscale-0 transition-all duration-500">
      <div className="text-xl font-bold tracking-widest text-white">CHATGPT</div>
      <div className="text-2xl font-serif font-bold text-white">Claude.ai</div>
      <div className="text-xl font-semibold flex items-center gap-1 text-white"><span className="text-2xl">Cur</span>sor</div>
      <div className="text-xl font-semibold flex items-center gap-2 text-white">
        <div className="flex gap-0.5"><div className="w-1.5 h-1.5 bg-[#4ade80] rounded-full"/><div className="w-1.5 h-1.5 bg-white rounded-full"/></div>
        ZITADEL
      </div>
      <div className="text-xl font-semibold flex items-center gap-2 text-white">
         <div className="w-6 h-5 border-2 border-white rounded flex items-center justify-center relative">
            <div className="w-1 h-1 bg-[#4ade80] absolute -top-1 left-1 rounded-full"/>
            <div className="w-1 h-1 bg-white absolute -top-1 right-1 rounded-full"/>
         </div>
         Hetzner
      </div>
    </div>
  </section>
);

const FeatureNaturalness = () => (
  <section className="w-full bg-[#0a0a0a] border-b border-[#ffffff10] relative grid-container">
    <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_1.2fr] border-x border-[#ffffff10] min-h-[600px]">
      
      {/* Left Text */}
      <div className="p-12 md:p-20 flex flex-col justify-center border-r border-[#ffffff10]">
        <h2 className="text-white text-4xl md:text-5xl font-medium tracking-tight mb-8">
          The Ultimate<br />API Key
        </h2>
        <p className="text-[#a1a1aa] text-2xl md:text-[28px] leading-[1.4] font-normal">
          A single credential that works in <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-[#222] text-[#4ade80] text-sm mx-1 font-mono border border-[#333]">1</span> ChatGPT,<br/>
          <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-[#222] text-[#4ade80] text-sm mx-1 font-mono border border-[#333]">2</span> Claude, and<br/>
          <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-[#222] text-[#4ade80] text-sm mx-1 font-mono border border-[#333]">3</span> Cursor. Built on<br/>
          ZITADEL, it supports instant <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-[#222] text-[#4ade80] text-sm mx-1 font-mono border border-[#333]">4</span> revocation and<br/>
          <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-[#222] text-[#4ade80] text-sm mx-1 font-mono border border-[#333]">5</span> RBAC out of the box.
        </p>
      </div>

      {/* Right Gradient Box */}
      <div className="relative p-12 md:p-20 flex items-center justify-center min-h-[400px] overflow-hidden">
        {/* Grainy vibrant background simulation */}
        <div className="absolute inset-0 bg-gradient-to-br from-[#e0f2fe] via-[#a3e635] to-[#16a34a] opacity-90 mix-blend-screen" />
        <div className="absolute inset-0 bg-[#0a0a0a] opacity-10" style={{ filter: 'url(#noise)' }} />
        
        {/* Noise SVG filter for grain */}
        <svg className="hidden">
            <filter id="noise">
                <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch"/>
                <feColorMatrix type="matrix" values="1 0 0 0 0, 0 1 0 0 0, 0 0 1 0 0, 0 0 0 0.2 0" />
            </filter>
        </svg>

        <p className="relative z-10 text-[#000000] text-2xl md:text-3xl lg:text-[32px] leading-[1.3] text-center font-medium mix-blend-overlay opacity-80 max-w-lg">
          The "Key-as-a-Service" model: A portable identity ensuring your project context follows you instantly.
        </p>
        {/* Fallback readable text if mix-blend fails */}
        <p className="absolute z-20 text-[#111] text-2xl md:text-3xl lg:text-[32px] leading-[1.3] text-center font-medium max-w-lg px-12" style={{ textShadow: '0 2px 10px rgba(255,255,255,0.5)'}}>
          The "Key-as-a-Service" model: A portable identity ensuring your project context follows you instantly.
        </p>
      </div>
    </div>
  </section>
);

const CarouselSection = () => {
  const [slide, setSlide] = useState(0);

  const slides = [
    {
      id: '01',
      title: 'AST-Aware Intelligence',
      desc: 'We don\'t just search your code; we understand your classes and scopes. We are the only engine that doesn\'t fragment your logic.',
      content: (
        <div className="py-20">
          <h3 className="text-[#555] font-mono text-sm mb-12">[01]</h3>
          <div className="relative inline-block mt-4 mb-24">
            
            <h2 className="text-[40px] md:text-[56px] font-medium tracking-tight leading-tight">
              <span className="text-[#4ade80]">Deep </span>
              {/* Word 1 with top annotation */}
              <span className="relative inline-block text-[#4ade80]">
                AST-aware
                <div className="absolute bottom-[90%] left-1/2 w-[200px] h-[40px] pointer-events-none">
                    <svg width="100%" height="100%" className="overflow-visible">
                        <path d="M 0,40 L 15,10 L 80,10" fill="none" stroke="#666" strokeWidth="1" />
                        <text x="85" y="14" fill="#a1a1aa" fontSize="10" fontFamily="monospace" letterSpacing="0.05em">UNDERSTANDS SCOPE</text>
                    </svg>
                </div>
              </span>
              <span className="text-[#4ade80]"> code memory that </span>
              {/* Word 2 with bottom annotation */}
              <span className="relative inline-block text-[#4ade80]">
                understands logic,
                <div className="absolute top-[90%] left-[80%] w-[200px] h-[40px] pointer-events-none">
                    <svg width="100%" height="100%" className="overflow-visible">
                        <path d="M 0,0 L 15,30 L 80,30" fill="none" stroke="#666" strokeWidth="1" />
                        <text x="85" y="34" fill="#a1a1aa" fontSize="10" fontFamily="monospace" letterSpacing="0.05em">NOT JUST SEARCH</text>
                    </svg>
                </div>
              </span>
              <span className="text-[#555]"> not just text.</span>
            </h2>
            
          </div>

          <div className="flex justify-between items-end mt-12">
            <div>
              <h4 className="text-white text-xl mb-2">AST-Aware Intelligence</h4>
              <p className="text-[#888] text-sm max-w-sm">
                We don't just search your code; we understand your classes and scopes. We are the only engine that doesn't fragment your logic.
              </p>
            </div>
            <button className="w-12 h-12 rounded-full bg-[#222] hover:bg-[#333] flex items-center justify-center text-white transition-colors">
              <Code2 size={20} />
            </button>
          </div>
        </div>
      )
    },
    {
      id: '02',
      title: 'The Smart Forgetting Curve',
      desc: 'We don\'t remember everything forever. Our Ebbinghaus decay engine saves costs by managing the context window intelligently.',
      content: (
        <div className="py-20">
          <h3 className="text-[#555] font-mono text-sm mb-12">[02]</h3>
          <div className="relative inline-block mt-4 mb-24">
            
            <h2 className="text-[40px] md:text-[56px] font-medium tracking-tight leading-tight">
              {/* Word with top annotation */}
              <span className="relative inline-block text-[#4ade80]">
                Ebbinghaus
                <div className="absolute bottom-[90%] left-[40%] w-[200px] h-[40px] pointer-events-none">
                    <svg width="100%" height="100%" className="overflow-visible">
                        <path d="M 0,40 L 20,10 L 100,10" fill="none" stroke="#666" strokeWidth="1" />
                        <text x="105" y="14" fill="#a1a1aa" fontSize="10" fontFamily="monospace" letterSpacing="0.05em">DECAY ENGINE</text>
                    </svg>
                </div>
              </span>
              <span className="text-[#4ade80]"> intelligently manages the </span>
              {/* Word with bottom annotation */}
              <span className="relative inline-block text-[#4ade80]">
                context window,
                <div className="absolute top-[90%] left-[10%] w-[200px] h-[40px] pointer-events-none">
                    <svg width="100%" height="100%" className="overflow-visible">
                        <path d="M 0,0 L 15,30 L 80,30" fill="none" stroke="#666" strokeWidth="1" />
                        <text x="85" y="34" fill="#a1a1aa" fontSize="10" fontFamily="monospace" letterSpacing="0.05em">MAXIMIZES RELEVANCE</text>
                    </svg>
                </div>
              </span>
              <span className="text-[#555]"> saving costs.</span>
            </h2>
            
          </div>

          <div className="flex justify-between items-end mt-12">
            <div>
              <h4 className="text-white text-xl mb-2">The Smart Forgetting Curve</h4>
              <p className="text-[#888] text-sm max-w-sm">
                We don't remember everything forever. Our Ebbinghaus decay engine saves costs by managing the context window intelligently.
              </p>
            </div>
            <button className="w-12 h-12 rounded-full bg-[#222] hover:bg-[#333] flex items-center justify-center text-white transition-colors">
              <Database size={20} />
            </button>
          </div>
        </div>
      )
    }
  ];

  const nextSlide = () => setSlide((s) => (s === 1 ? 0 : 1));
  const prevSlide = () => setSlide((s) => (s === 0 ? 1 : 0));

  return (
    <section className="w-full bg-[#0a0a0a] relative grid-container py-16 border-b border-[#ffffff10]">
      <div className="max-w-7xl mx-auto px-6 md:px-20 border-x border-[#ffffff10] h-full flex flex-col">
        
        {/* Header */}
        <div className="flex justify-between items-start pt-10">
          <div>
            <h2 className="text-white text-4xl md:text-[44px] leading-tight font-medium mb-6">
              Platform Integration<br />Strategy
            </h2>
            <button className="bg-white text-black px-5 py-2 rounded-full font-medium text-sm hover:bg-gray-100 transition-colors">
              View Connectors
            </button>
          </div>
          
          <div className="flex gap-3">
            <button onClick={prevSlide} className="w-10 h-10 rounded-full bg-[#222] hover:bg-[#333] flex items-center justify-center text-white transition-colors">
              <ChevronLeft size={20} />
            </button>
            <button onClick={nextSlide} className="w-10 h-10 rounded-full bg-[#222] hover:bg-[#333] flex items-center justify-center text-white transition-colors">
              <ChevronRight size={20} />
            </button>
          </div>
        </div>

        {/* Dynamic Content */}
        <div className="flex-grow flex items-center border-t border-[#ffffff05] mt-12">
          {slides[slide].content}
        </div>

      </div>
    </section>
  );
};

const SpeedSection = () => (
    <section className="w-full bg-[#0a0a0a] relative grid-container py-24">
        <div className="max-w-7xl mx-auto px-6 md:px-20 border-x border-[#ffffff10] flex flex-col md:flex-row gap-16 md:gap-32">
            <div className="flex-1">
                <h2 className="text-white text-4xl md:text-[48px] leading-tight font-medium mb-10">
                    Sovereign-First<br/>architecture
                </h2>
                <div className="inline-flex rounded-full border border-[#333] p-1 bg-[#111]">
                    <button className="bg-[#333] text-[#4ade80] px-5 py-2 rounded-full text-sm font-medium">
                        CLOUD Act Immune
                    </button>
                    <button className="text-[#888] hover:text-white px-5 py-2 rounded-full text-sm font-medium transition-colors">
                        HYOK Supported
                    </button>
                </div>
            </div>
            <div className="flex-1 flex flex-col justify-center">
                <p className="text-[#e5e5e5] text-lg mb-8 max-w-md leading-relaxed">
                    Built for the enterprise. Choose on-premise deployment or Managed HSM (Hardware Security Module) where you hold your own encryption keys.
                </p>
                <div>
                     <button className="bg-white text-black px-6 py-2.5 rounded-full font-medium hover:bg-gray-100 transition-colors">
                        Contact Sales for Enterprise
                    </button>
                </div>
            </div>
        </div>
    </section>
)


// --- Main App ---

export default function App() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-[#4ade80] selection:text-black">
      {/* Global CSS for specific background patterns */}
      <style>{`
        /* Vertical grid lines mimicking the design */
        .grid-container::before {
          content: '';
          position: absolute;
          inset: 0;
          background-image: linear-gradient(to right, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
          background-size: min(16.666%, 200px) 100%;
          background-position: center;
          pointer-events: none;
          z-index: 0;
        }
        .grid-container > div {
            position: relative;
            z-index: 10;
        }
      `}</style>

      <TopBanner />
      <Navbar />
      
      <main>
        <Hero />
        <LogoCloud />
        <FeatureNaturalness />
        <CarouselSection />
        <SpeedSection />
      </main>
    </div>
  );
}
