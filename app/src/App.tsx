import React, { useEffect, useState } from 'react';
import { Mic, Activity, FileText, Settings, BarChart2, History, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import LiveMeetingView from './components/LiveMeetingView';
import DashboardView from './components/DashboardView';
import SettingsView from './components/SettingsView';
import ReportsView from './components/ReportsView';
import DailyReportView from './components/DailyReportView';

function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'live' | 'history' | 'reports' | 'settings'>('dashboard');
  const [isRecording, setIsRecording] = useState(false);
  const [meetingMode, setMeetingMode] = useState('General Executive');
  const [meetingAgenda, setMeetingAgenda] = useState('');
  const [meetingPrepNotes, setMeetingPrepNotes] = useState('');
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
            onStartMeeting={(mode, agenda, prepNotes) => {
              setMeetingMode(mode);
              setMeetingAgenda(agenda);
              setMeetingPrepNotes(prepNotes || '');
              setIsRecording(true);
              setActiveTab('live');
            }} 
            onViewHistory={() => setActiveTab('history')}
          />
        )}
        {activeTab === 'history' && <ReportsView initialMeetingId={selectedHistoryId} />}
        {activeTab === 'reports' && <DailyReportView />}
        {activeTab === 'settings' && <SettingsView />}
      </div>
    );
  };

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '0 4px', marginBottom: '1.75rem', height: '36px' }}>
          <div style={{
            width: '32px', height: '32px', borderRadius: '9px', flexShrink: 0,
            background: 'linear-gradient(135deg, var(--accent-primary), var(--color-praise))',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <Activity color="white" size={18} />
          </div>
          <span className="label" style={{ fontSize: '1.05rem', fontWeight: 600, letterSpacing: '-0.01em' }}>Eloquent</span>
        </div>

        <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <NavItem icon={<BarChart2 size={18} />} label="Dashboard" collapsed={collapsed}
            active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} />
          {isRecording && (
            <NavItem icon={<Mic size={18} color="var(--color-risk)" />} label="Live Coach" collapsed={collapsed}
              active={activeTab === 'live'} onClick={() => setActiveTab('live')} />
          )}
          <NavItem icon={<History size={18} />} label="Meeting History" collapsed={collapsed}
            active={activeTab === 'history'} onClick={() => setActiveTab('history')} />
          <NavItem icon={<FileText size={18} />} label="Reports" collapsed={collapsed}
            active={activeTab === 'reports'} onClick={() => setActiveTab('reports')} />
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
