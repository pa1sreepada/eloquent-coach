import React, { useState } from 'react';
import { Mic, Activity, FileText, Settings, BarChart2, History } from 'lucide-react';
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
      <aside className="sidebar">
        <div style={{ marginBottom: '2rem' }} className="flex-center">
          <div style={{ 
            width: '40px', height: '40px', borderRadius: '10px', 
            background: 'linear-gradient(135deg, var(--accent-primary), var(--color-praise))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginRight: '12px'
          }}>
            <Activity color="white" size={24} />
          </div>
          <h2 style={{ margin: 0, fontSize: '1.2rem', letterSpacing: '0.5px' }}>Eloquent</h2>
        </div>

        <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <NavItem 
            icon={<BarChart2 size={20} />} 
            label="Dashboard" 
            active={activeTab === 'dashboard'} 
            onClick={() => setActiveTab('dashboard')} 
          />
          {isRecording && (
            <NavItem 
              icon={<Mic size={20} color="var(--color-risk)" />} 
              label="Live Coach" 
              active={activeTab === 'live'} 
              onClick={() => setActiveTab('live')} 
            />
          )}
          <NavItem 
            icon={<History size={20} />} 
            label="Meeting History" 
            active={activeTab === 'history'} 
            onClick={() => setActiveTab('history')} 
          />
          <NavItem 
            icon={<FileText size={20} />} 
            label="Reports" 
            active={activeTab === 'reports'} 
            onClick={() => setActiveTab('reports')} 
          />
        </nav>

        <div style={{ marginTop: 'auto' }}>
          <NavItem 
            icon={<Settings size={20} />} 
            label="Settings" 
            active={activeTab === 'settings'} 
            onClick={() => setActiveTab('settings')} 
          />
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

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '0.8rem 1rem', borderRadius: '8px',
        background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
        color: active ? 'white' : 'var(--text-secondary)',
        border: 'none', cursor: 'pointer',
        transition: 'all 0.2s ease',
        textAlign: 'left',
        fontWeight: active ? 500 : 400
      }}
      onMouseOver={(e) => {
        if (!active) e.currentTarget.style.color = 'white';
      }}
      onMouseOut={(e) => {
        if (!active) e.currentTarget.style.color = 'var(--text-secondary)';
      }}
    >
      {icon}
      <span>{label}</span>
      {active && (
        <div style={{ 
          marginLeft: 'auto', width: '4px', height: '16px', 
          background: 'var(--accent-primary)', borderRadius: '4px' 
        }} />
      )}
    </button>
  );
}

export default App;
