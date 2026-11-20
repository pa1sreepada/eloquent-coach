import React, { useEffect, useState } from 'react';
import appIcon from './assets/icon.svg';
import { Mic, FileText, Settings, BarChart2, History, PanelLeftClose, PanelLeftOpen, ScrollText, Compass, TrendingUp, Users, WandSparkles } from 'lucide-react';
import LiveMeetingView from './components/LiveMeetingView';
import DashboardView from './components/DashboardView';
import SettingsView from './components/SettingsView';
import ReportsView from './components/ReportsView';
import DailyReportView from './components/DailyReportView';
import TeleprompterView from './components/TeleprompterView';
import PrepareView, { type StartArgs } from './components/PrepareView';
import GrowthView from './components/GrowthView';
import LeadershipView from './components/LeadershipView';
import RephraseView from './components/RephraseView';

type Tab = 'dashboard' | 'live' | 'prepare' | 'rephrase' | 'history' | 'growth' | 'leadership' | 'reports' | 'teleprompter' | 'settings';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [isRecording, setIsRecording] = useState(false);
  const [meetingMode, setMeetingMode] = useState('General Executive');
  const [meetingAgenda, setMeetingAgenda] = useState('');
  const [meetingPrepNotes, setMeetingPrepNotes] = useState('');
  const [meetingTitle, setMeetingTitle] = useState('');
  const [meetingAttendees, setMeetingAttendees] = useState('');
  const [selectedHistoryId, setSelectedHistoryId] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === '1');

  useEffect(() => { localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0'); }, [collapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); setCollapsed(c => !c); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const startMeeting = (a: StartArgs) => {
    if (isRecording) { setActiveTab('live'); return; }
    setMeetingMode(a.mode);
    setMeetingAgenda(a.agenda);
    setMeetingPrepNotes(a.prepNotes || '');
    setMeetingTitle(a.title || '');
    setMeetingAttendees(a.attendees || '');
    setIsRecording(true);
    setActiveTab('live');
  };

  const renderContent = () => {
    return (
      <div style={{ height: '100%', position: 'relative' }}>
        {/* Always keep LiveMeetingView mounted if recording to prevent losing the session */}
        <div style={{ display: activeTab === 'live' ? 'block' : 'none', height: '100%' }}>
          <LiveMeetingView 
            isRecording={isRecording} 
            mode={meetingMode}
            agenda={meetingAgenda}
            prepNotes={meetingPrepNotes}
            title={meetingTitle}
            attendees={meetingAttendees}
            onStopMeeting={(id) => {
              setIsRecording(false);
              if (id) {
                setSelectedHistoryId(id);
                setActiveTab('history');
              } else {
                setActiveTab('dashboard');
              }
            }} 
          />
        </div>

        {activeTab === 'dashboard' && (
          <DashboardView 
            onStartMeeting={startMeeting}
            onViewHistory={() => setActiveTab('history')}
            onOpen={(tab) => setActiveTab(tab)}
          />
        )}
        {activeTab === 'prepare' && <PrepareView onStartMeeting={startMeeting} />}
        {activeTab === 'rephrase' && <RephraseView />}
        {activeTab === 'growth' && <GrowthView />}
        {activeTab === 'leadership' && <LeadershipView />}
        {activeTab === 'history' && <ReportsView initialMeetingId={selectedHistoryId} />}
        {activeTab === 'reports' && <DailyReportView />}
        {activeTab === 'teleprompter' && <TeleprompterView />}
        {activeTab === 'settings' && <SettingsView />}
      </div>
    );
  };

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        {/* Room for the macOS close/minimise/zoom buttons; also lets you drag the window from here. */}
        <div className="titlebar" />
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '0 4px', marginBottom: '1.75rem', height: '36px' }}>
          {/* The SVG has macOS icon-grid padding; scale it so the tile fills 32px. */}
          <img src={appIcon} alt="" width={40} height={40} style={{ margin: '-4px', flexShrink: 0 }} />
          <div className="label" style={{ lineHeight: 1.15, whiteSpace: 'nowrap' }}>
            <div style={{ fontSize: '1.02rem', fontWeight: 600, letterSpacing: '-0.01em' }}>Eloquent Coach</div>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-tertiary)' }}>Your edge in every meeting</div>
          </div>
        </div>

        <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px', overflowY: 'auto', overflowX: 'hidden' }}>
          {navGroups(isRecording).map(g => (
            <div key={g.title} className="nav-group" role="group" aria-label={g.title}>
              <div className="nav-section"><span className="label">{g.title}</span></div>
              {g.items.map(i => (
                <NavItem key={i.tab} icon={i.icon} label={i.label} collapsed={collapsed}
                  active={activeTab === i.tab} onClick={() => setActiveTab(i.tab)} />
              ))}
            </div>
          ))}
        </nav>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <NavItem icon={<Settings size={18} />} label="Settings" collapsed={collapsed}
            active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
          <NavItem icon={collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} collapsed={collapsed}
            active={false} onClick={() => setCollapsed(c => !c)} hint={'⌘\\'} />
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        {/* Decorative background blur elements */}
        <div style={{
          position: 'absolute', top: '-10%', right: '-5%', width: '400px', height: '400px',
          background: 'radial-gradient(circle, rgba(59,130,246,0.1) 0%, rgba(0,0,0,0) 70%)',
          zIndex: 0, pointerEvents: 'none'
        }} />
        <div style={{
          position: 'absolute', bottom: '-10%', left: '10%', width: '500px', height: '500px',
          background: 'radial-gradient(circle, rgba(139,92,246,0.05) 0%, rgba(0,0,0,0) 70%)',
          zIndex: 0, pointerEvents: 'none'
        }} />
        
        <div style={{ position: 'relative', zIndex: 1, height: '100%' }}>
          {renderContent()}
        </div>
      </main>
    </div>
  );
}

interface NavEntry { tab: Tab; label: string; icon: React.ReactNode }

/** Sidebar sections, ordered by the meeting workflow: before, during and after, then writing and long-term growth. */
function navGroups(isRecording: boolean): { title: string; items: NavEntry[] }[] {
  return [
    { title: 'Workspace', items: [
      { tab: 'dashboard', label: 'Dashboard', icon: <BarChart2 size={18} /> },
      ...(isRecording ? [{ tab: 'live' as Tab, label: 'Live Coach', icon: <Mic size={18} color="var(--color-risk)" /> }] : []),
    ] },
    { title: 'Meetings', items: [
      { tab: 'prepare', label: 'Prepare', icon: <Compass size={18} /> },
      { tab: 'history', label: 'Meeting History', icon: <History size={18} /> },
      { tab: 'reports', label: 'Reports', icon: <FileText size={18} /> },
    ] },
    { title: 'Communicate', items: [
      { tab: 'rephrase', label: 'Rephrase', icon: <WandSparkles size={18} /> },
      { tab: 'teleprompter', label: 'Teleprompter', icon: <ScrollText size={18} /> },
    ] },
    { title: 'Leadership & Growth', items: [
      { tab: 'leadership', label: 'Leadership', icon: <Users size={18} /> },
      { tab: 'growth', label: 'Growth', icon: <TrendingUp size={18} /> },
    ] },
  ];
}

function NavItem({ icon, label, active, onClick, collapsed, hint }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void, collapsed: boolean, hint?: string }) {
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}
      title={collapsed ? label : hint} aria-label={label}>
      {icon}
      <span className="label">{label}</span>
    </button>
  );
}

export default App;
