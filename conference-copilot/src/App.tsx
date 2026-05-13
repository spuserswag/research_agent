import React, { useState, useEffect, ChangeEvent } from 'react';
import { 
  LayoutDashboard, 
  Users, 
  Star, 
  Plus, 
  Search, 
  Upload, 
  ChevronDown, 
  ChevronUp,
  MapPin,
  Calendar,
  Building2,
  DollarSign,
  Users2,
  StickyNote,
  X,
  Phone,
  Mail,
  Briefcase,
  Contact as ContactIcon,
  Pencil
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  QueryClient, 
  QueryClientProvider, 
  useQuery, 
  useMutation, 
  useQueryClient 
} from '@tanstack/react-query';
import axios from 'axios';
import * as xlsx from 'xlsx';
import { debounce } from 'lodash';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- Utils ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const queryClient = new QueryClient();

// --- LocalStorage Fallback Logic ---
const getLocal = (key: string) => JSON.parse(localStorage.getItem(key) || '[]');
const setLocal = (key: string, val: any) => localStorage.setItem(key, JSON.stringify(val));

const api = {
  getConferences: async () => {
    try {
      const res = await axios.get('/api/conferences');
      setLocal('aec_conferences', res.data);
      return res.data;
    } catch (e) {
      return getLocal('aec_conferences');
    }
  },
  createConference: async (data: { name: string, date?: string, location?: string, address?: string }) => {
    try {
      const res = await axios.post('/api/conferences', data);
      return res.data;
    } catch (e) {
      const confs = getLocal('aec_conferences');
      const newConf = { id: `local-${Date.now()}`, ...data };
      setLocal('aec_conferences', [...confs, newConf]);
      return newConf;
    }
  },
  getExhibitors: async (conferenceId: string) => {
    try {
      const res = await axios.get(`/api/exhibitors?conferenceId=${conferenceId}`);
      setLocal(`aec_exhibitors_${conferenceId}`, res.data);
      return res.data;
    } catch (e) {
      return getLocal(`aec_exhibitors_${conferenceId}`);
    }
  },
  updateExhibitor: async (id: string, conferenceId: string, data: any) => {
    try {
      const res = await axios.patch(`/api/exhibitors/${id}`, data);
      return res.data;
    } catch (e) {
      const exhibitors = getLocal(`aec_exhibitors_${conferenceId}`);
      const updated = exhibitors.map((ex: any) => ex.id === id ? { ...ex, ...data } : ex);
      setLocal(`aec_exhibitors_${conferenceId}`, updated);
      return data;
    }
  },
  importExhibitors: async (conferenceId: string, data: any[]) => {
    try {
      const res = await axios.post('/api/exhibitors/import', { conferenceId, data });
      return res.data;
    } catch (e) {
      const exhibitors = getLocal(`aec_exhibitors_${conferenceId}`);
      const newExhibitors = data.map((d, i) => ({ ...d, id: `local-ex-${Date.now()}-${i}`, conferenceId, isShortlisted: false }));
      setLocal(`aec_exhibitors_${conferenceId}`, [...exhibitors, ...newExhibitors]);
      return { count: data.length };
    }
  },
  getContacts: async (conferenceId: string) => {
    try {
      const res = await axios.get(`/api/contacts?conferenceId=${conferenceId}`);
      setLocal(`aec_contacts_${conferenceId}`, res.data);
      return res.data;
    } catch (e) {
      return getLocal(`aec_contacts_${conferenceId}`);
    }
  },
  createContact: async (data: Omit<Contact, 'id'>) => {
    try {
      const res = await axios.post('/api/contacts', data);
      return res.data;
    } catch (e) {
      const contacts = getLocal(`aec_contacts_${data.conferenceId}`);
      const newContact = { 
        ...data, 
        id: `local-contact-${Date.now()}-${Math.random().toString(36).substring(2, 9)}` 
      };
      setLocal(`aec_contacts_${data.conferenceId}`, [...contacts, newContact]);
      return newContact;
    }
  },
  updateContact: async (id: string, conferenceId: string, data: Partial<Contact>) => {
    try {
      const res = await axios.patch(`/api/contacts/${id}`, data);
      return res.data;
    } catch (e) {
      const contacts = getLocal(`aec_contacts_${conferenceId}`);
      const updated = contacts.map((c: any) => c.id === id ? { ...c, ...data } : c);
      setLocal(`aec_contacts_${conferenceId}`, updated);
      return data;
    }
  }
};

// --- Components ---
interface Conference {
  id: string;
  name: string;
  date?: string;
  location?: string;
  address?: string;
}

interface Exhibitor {
  id: string;
  companyName: string;
  boothNumber?: string;
  industry?: string;
  estimatedRevenue?: string;
  employeeCount?: string;
  notes?: string;
  isShortlisted: boolean;
  conferenceId: string;
}

interface Contact {
  id: string;
  name: string;
  title: string;
  company: string;
  phoneNumber: string;
  emailAddress: string;
  conferenceId: string;
}

// --- Components ---

const Logo = () => (
  <motion.div 
    initial={{ y: -20, opacity: 0 }}
    animate={{ y: 0, opacity: 1 }}
    className="group shrink-0"
  >
    <div className="w-14 h-14 bg-navy-card border-2 border-gold rounded-2xl flex items-center justify-center relative shadow-[0_0_20px_rgba(212,175,55,0.1)] transition-all duration-500 group-hover:shadow-[0_0_30px_rgba(212,175,55,0.2)] group-hover:border-gold/60">
      {/* Decorative corners */}
      <div className="absolute -top-1 -left-1 w-3 h-3 border-t-2 border-l-2 border-gold" />
      <div className="absolute -bottom-1 -right-1 w-3 h-3 border-b-2 border-r-2 border-gold" />
      
      <svg viewBox="0 0 24 24" className="w-8 h-8 text-gold" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 22V4c0-.5.5-1 1-1h14c.5 0 1 .5 1 1v18" />
        <path d="M8 22V8c0-.5.5-1 1-1h6c.5 0 1 .5 1 1v14" />
        <path d="M12 22V12" />
        <path d="M2 22h20" />
      </svg>
    </div>
  </motion.div>
);

const BottomNav = ({ activeTab, setActiveTab }: { activeTab: string, setActiveTab: (t: string) => void }) => (
  <nav className="fixed bottom-0 left-0 right-0 h-24 bg-navy-card/60 backdrop-blur-3xl border-t border-gold/10 flex items-center justify-around px-4 pb-4 z-50">
    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-[1px] bg-gradient-to-r from-transparent via-gold/50 to-transparent" />
    <button onClick={() => setActiveTab('conferences')} className={cn("nav-item relative", activeTab === 'conferences' && "active")}>
      <LayoutDashboard size={22} />
      <span className="mono-label">Events</span>
      {activeTab === 'conferences' && <motion.div layoutId="nav-glow" className="absolute -bottom-2 w-1 h-1 bg-gold rounded-full gold-glow" />}
    </button>
    <button onClick={() => setActiveTab('exhibitors')} className={cn("nav-item relative", activeTab === 'exhibitors' && "active")}>
      <Users size={22} />
      <span className="mono-label">Exhibitors</span>
      {activeTab === 'exhibitors' && <motion.div layoutId="nav-glow" className="absolute -bottom-2 w-1 h-1 bg-gold rounded-full gold-glow" />}
    </button>
    <button onClick={() => setActiveTab('contacts')} className={cn("nav-item relative", activeTab === 'contacts' && "active")}>
      <ContactIcon size={22} />
      <span className="mono-label">Contacts</span>
      {activeTab === 'contacts' && <motion.div layoutId="nav-glow" className="absolute -bottom-2 w-1 h-1 bg-gold rounded-full gold-glow" />}
    </button>
    <button onClick={() => setActiveTab('shortlist')} className={cn("nav-item relative", activeTab === 'shortlist' && "active")}>
      <Star size={22} />
      <span className="mono-label">Shortlist</span>
      {activeTab === 'shortlist' && <motion.div layoutId="nav-glow" className="absolute -bottom-2 w-1 h-1 bg-gold rounded-full gold-glow" />}
    </button>
  </nav>
);

const ExhibitorCard: React.FC<{ exhibitor: Exhibitor }> = ({ exhibitor }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const queryClient = useQueryClient();
  
  const updateMutation = useMutation({
    mutationFn: (data: Partial<Exhibitor>) => api.updateExhibitor(exhibitor.id, exhibitor.conferenceId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exhibitors', exhibitor.conferenceId] });
    }
  });

  const debouncedUpdate = debounce((field: string, value: string) => {
    updateMutation.mutate({ [field]: value });
  }, 500);

  const toggleShortlist = () => {
    updateMutation.mutate({ isShortlisted: !exhibitor.isShortlisted });
  };

  const handleTextareaChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    e.target.style.height = 'inherit';
    e.target.style.height = `${e.target.scrollHeight}px`;
    debouncedUpdate('notes', e.target.value);
  };

  return (
    <motion.div 
      layout
      className={cn(
        "glass-card mb-4 overflow-hidden transition-all duration-500",
        isExpanded ? "border-gold/30 ring-1 ring-gold/10" : "hover:border-white/10"
      )}
    >
      <div className="p-5 flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0" onClick={() => setIsExpanded(!isExpanded)}>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-black text-lg tracking-tight truncate uppercase italic">{exhibitor.companyName}</h3>
            {exhibitor.boothNumber && (
              <span className="font-mono text-[9px] bg-gold/10 text-gold px-2 py-0.5 rounded border border-gold/30 uppercase tracking-widest">
                ID: {exhibitor.boothNumber}
              </span>
            )}
          </div>
          <p className="mono-label mt-1 opacity-70 truncate">{exhibitor.industry || 'Sector: Unclassified'}</p>
        </div>
        <div className="flex items-center gap-1">
          <button 
            onClick={toggleShortlist}
            className={cn("p-2 rounded-full transition-all duration-300", exhibitor.isShortlisted ? "text-gold" : "text-slate-600")}
          >
            <Star size={18} fill={exhibitor.isShortlisted ? "currentColor" : "none"} />
          </button>
          <button onClick={() => setIsExpanded(!isExpanded)} className="p-2 text-slate-500 hover:text-gold transition-colors">
            {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {isExpanded && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="px-5 pb-5 border-t border-white/5 pt-5 space-y-5"
          >
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="mono-label">Est. Revenue</label>
                <div className="flex items-center gap-2 bg-navy-deep/40 p-3 rounded-xl border border-white/5 focus-within:border-gold/30 transition-colors">
                  <DollarSign size={14} className="text-gold/60" />
                  <input 
                    defaultValue={exhibitor.estimatedRevenue}
                    onChange={(e) => debouncedUpdate('estimatedRevenue', e.target.value)}
                    className="bg-transparent border-none outline-none text-sm w-full font-mono"
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="mono-label">Personnel</label>
                <div className="flex items-center gap-2 bg-navy-deep/40 p-3 rounded-xl border border-white/5 focus-within:border-gold/30 transition-colors">
                  <Users2 size={14} className="text-gold/60" />
                  <input 
                    defaultValue={exhibitor.employeeCount}
                    onChange={(e) => debouncedUpdate('employeeCount', e.target.value)}
                    className="bg-transparent border-none outline-none text-sm w-full font-mono"
                    placeholder="0"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label className="mono-label">Intelligence / Notes</label>
              <div className="flex gap-3 bg-navy-deep/40 p-4 rounded-xl border border-white/5 focus-within:border-gold/30 transition-colors">
                <StickyNote size={14} className="text-gold/60 mt-1 shrink-0" />
                <textarea 
                  defaultValue={exhibitor.notes}
                  onChange={handleTextareaChange}
                  onFocus={(e) => {
                    e.target.style.height = 'inherit';
                    e.target.style.height = `${e.target.scrollHeight}px`;
                  }}
                  className="bg-transparent border-none outline-none text-sm w-full min-h-[120px] resize-none overflow-hidden leading-relaxed"
                  placeholder="Input strategic data..."
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

const ContactCard: React.FC<{ contact: Contact, onEdit: (contact: Contact) => void }> = ({ contact, onEdit }) => {
  return (
    <motion.div 
      layout
      className="glass-card mb-4 overflow-hidden border-white/5 hover:border-gold/30 transition-all duration-500"
    >
      <div className="p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-black text-lg tracking-tight truncate uppercase italic">{contact.name}</h3>
            <p className="mono-label mt-1 text-gold/80">{contact.title || 'No Title'}</p>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => onEdit(contact)}
              className="p-2 bg-white/5 hover:bg-gold/10 text-slate-400 hover:text-gold rounded-lg border border-white/5 hover:border-gold/20 transition-all"
            >
              <Pencil size={14} />
            </button>
            <div className="p-2 bg-gold/10 rounded-lg border border-gold/20">
              <ContactIcon size={16} className="text-gold" />
            </div>
          </div>
        </div>

        <div className="space-y-2 pt-2 border-t border-white/5">
          <div className="flex items-center gap-3 text-slate-400">
            <Building2 size={14} className="shrink-0 text-gold/40" />
            <span className="text-xs font-mono uppercase tracking-wider truncate">{contact.company || 'No Company'}</span>
          </div>
          <div className="flex items-center gap-3 text-slate-400">
            <Phone size={14} className="shrink-0 text-gold/40" />
            <span className="text-xs font-mono tracking-wider">{contact.phoneNumber || 'No Phone'}</span>
          </div>
          <div className="flex items-center gap-3 text-slate-400">
            <Mail size={14} className="shrink-0 text-gold/40" />
            <span className="text-xs font-mono tracking-wider truncate">{contact.emailAddress || 'No Email'}</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

const ContactModal = ({ 
  isOpen, 
  onClose, 
  onSubmit, 
  initialData,
  title = "New Contact"
}: { 
  isOpen: boolean, 
  onClose: () => void, 
  onSubmit: (data: any) => void,
  initialData?: Partial<Contact> | null,
  title?: string
}) => {
  const [formData, setFormData] = useState({ 
    name: '', 
    title: '', 
    company: '', 
    phoneNumber: '', 
    emailAddress: '' 
  });

  useEffect(() => {
    if (initialData) {
      setFormData({
        name: initialData.name || '',
        title: initialData.title || '',
        company: initialData.company || '',
        phoneNumber: initialData.phoneNumber || '',
        emailAddress: initialData.emailAddress || ''
      });
    } else {
      setFormData({ 
        name: '', 
        title: '', 
        company: '', 
        phoneNumber: '', 
        emailAddress: '' 
      });
    }
  }, [initialData, isOpen]);

  if (!isOpen) return null;

  const isFormValid = formData.name;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-navy-deep/80 backdrop-blur-sm"
      />
      <motion.div 
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        className="glass-card w-full max-w-sm p-6 relative z-10 space-y-6"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-black uppercase italic tracking-tight">{title}</h2>
          <button onClick={onClose} className="p-2 text-slate-500"><X size={20} /></button>
        </div>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto px-1">
          <div className="space-y-1">
            <label className="mono-label">Full Name <span className="text-gold">*</span></label>
            <input 
              autoFocus
              value={formData.name}
              onChange={e => setFormData({ ...formData, name: e.target.value })}
              className="w-full bg-navy-deep/50 border border-white/10 rounded-xl p-3 text-sm outline-none focus:border-gold/40"
              placeholder="e.g. John Doe"
            />
          </div>
          <div className="space-y-1">
            <label className="mono-label">Title</label>
            <input 
              value={formData.title}
              onChange={e => setFormData({ ...formData, title: e.target.value })}
              className="w-full bg-navy-deep/50 border border-white/10 rounded-xl p-3 text-sm outline-none focus:border-gold/40"
              placeholder="e.g. Senior Architect"
            />
          </div>
          <div className="space-y-1">
            <label className="mono-label">Company</label>
            <input 
              value={formData.company}
              onChange={e => setFormData({ ...formData, company: e.target.value })}
              className="w-full bg-navy-deep/50 border border-white/10 rounded-xl p-3 text-sm outline-none focus:border-gold/40"
              placeholder="e.g. AEC Solutions"
            />
          </div>
          <div className="space-y-1">
            <label className="mono-label">Phone Number</label>
            <input 
              type="tel"
              value={formData.phoneNumber}
              onChange={e => setFormData({ ...formData, phoneNumber: e.target.value })}
              className="w-full bg-navy-deep/50 border border-white/10 rounded-xl p-3 text-sm outline-none focus:border-gold/40"
              placeholder="+1 (555) 000-0000"
            />
          </div>
          <div className="space-y-1">
            <label className="mono-label">Email Address</label>
            <input 
              type="email"
              value={formData.emailAddress}
              onChange={e => setFormData({ ...formData, emailAddress: e.target.value })}
              className="w-full bg-navy-deep/50 border border-white/10 rounded-xl p-3 text-sm outline-none focus:border-gold/40"
              placeholder="john@example.com"
            />
          </div>
        </div>

        <button 
          disabled={!isFormValid}
          onClick={() => onSubmit(formData)}
          className="gold-button w-full disabled:opacity-50 disabled:active:scale-100"
        >
          {initialData ? 'Update Contact' : 'Save Contact'}
        </button>
      </motion.div>
    </div>
  );
};

const CreateConferenceModal = ({ isOpen, onClose, onSubmit }: { isOpen: boolean, onClose: () => void, onSubmit: (data: any) => void }) => {
  const [formData, setFormData] = useState({ name: '', date: '', location: '', address: '' });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-navy-deep/80 backdrop-blur-sm"
      />
      <motion.div 
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        className="glass-card w-full max-w-sm p-6 relative z-10 space-y-6"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-black uppercase italic tracking-tight">New Event</h2>
          <button onClick={onClose} className="p-2 text-slate-500"><X size={20} /></button>
        </div>

        <div className="space-y-4">
          <div className="space-y-1">
            <label className="mono-label">Event Name</label>
            <input 
              autoFocus
              value={formData.name}
              onChange={e => setFormData({ ...formData, name: e.target.value })}
              className="w-full bg-navy-deep/50 border border-white/10 rounded-xl p-3 text-sm outline-none focus:border-gold/40"
              placeholder="e.g. AEC Tech 2026"
            />
          </div>
          <div className="space-y-1">
            <label className="mono-label">Date</label>
            <input 
              type="date"
              value={formData.date}
              onChange={e => setFormData({ ...formData, date: e.target.value })}
              className="w-full bg-navy-deep/50 border border-white/10 rounded-xl p-3 text-sm outline-none focus:border-gold/40"
            />
          </div>
          <div className="space-y-1">
            <label className="mono-label">City / State</label>
            <input 
              value={formData.location}
              onChange={e => setFormData({ ...formData, location: e.target.value })}
              className="w-full bg-navy-deep/50 border border-white/10 rounded-xl p-3 text-sm outline-none focus:border-gold/40"
              placeholder="e.g. New York, NY"
            />
          </div>
          <div className="space-y-1">
            <label className="mono-label">Address</label>
            <input 
              value={formData.address}
              onChange={e => setFormData({ ...formData, address: e.target.value })}
              className="w-full bg-navy-deep/50 border border-white/10 rounded-xl p-3 text-sm outline-none focus:border-gold/40"
              placeholder="e.g. 123 Convention Way"
            />
          </div>
        </div>

        <button 
          disabled={!formData.name}
          onClick={() => onSubmit(formData)}
          className="gold-button w-full disabled:opacity-50 disabled:active:scale-100"
        >
          Initialize Event
        </button>
      </motion.div>
    </div>
  );
};

// --- Main App ---

function AppContent() {
  const [activeTab, setActiveTab] = useState('conferences');
  const [selectedConference, setSelectedConference] = useState<Conference | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isContactModalOpen, setIsContactModalOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const queryClient = useQueryClient();

  // Redirect to exhibitors if conference selected
  useEffect(() => {
    if (selectedConference && activeTab === 'conferences') {
      setActiveTab('exhibitors');
    }
  }, [selectedConference]);

  const { data: conferences, isLoading: loadingConfs } = useQuery({
    queryKey: ['conferences'],
    queryFn: api.getConferences
  });

  const { data: exhibitors, isLoading: loadingExhibitors } = useQuery({
    queryKey: ['exhibitors', selectedConference?.id],
    queryFn: () => api.getExhibitors(selectedConference!.id),
    enabled: !!selectedConference
  });

  const { data: contacts, isLoading: loadingContacts } = useQuery({
    queryKey: ['contacts', selectedConference?.id],
    queryFn: () => api.getContacts(selectedConference!.id),
    enabled: !!selectedConference
  });

  const createConfMutation = useMutation({
    mutationFn: api.createConference,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['conferences'] });
      setSelectedConference(data);
    }
  });

  const createContactMutation = useMutation({
    mutationFn: (data: any) => api.createContact({ ...data, conferenceId: selectedConference!.id }),
    onSuccess: (newContact) => {
      queryClient.setQueryData(['contacts', selectedConference?.id], (old: any) => {
        const currentContacts = Array.isArray(old) ? old : [];
        return [...currentContacts, newContact];
      });
      queryClient.invalidateQueries({ queryKey: ['contacts', selectedConference?.id] });
      setIsContactModalOpen(false);
    }
  });

  const updateContactMutation = useMutation({
    mutationFn: (data: Partial<Contact>) => api.updateContact(editingContact!.id, selectedConference!.id, data),
    onSuccess: (updatedData) => {
      queryClient.setQueryData(['contacts', selectedConference?.id], (old: any) => {
        if (!Array.isArray(old)) return [updatedData];
        return old.map((c: Contact) => c.id === editingContact!.id ? { ...c, ...updatedData } : c);
      });
      queryClient.invalidateQueries({ queryKey: ['contacts', selectedConference?.id] });
      setIsContactModalOpen(false);
      setEditingContact(null);
    }
  });

  const handleContactSubmit = (data: any) => {
    if (editingContact) {
      updateContactMutation.mutate(data);
    } else {
      createContactMutation.mutate(data);
    }
  };

  const importMutation = useMutation({
    mutationFn: (data: any[]) => api.importExhibitors(selectedConference!.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exhibitors', selectedConference?.id] });
      setIsImporting(false);
    }
  });

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      const bstr = evt.target?.result;
      const wb = xlsx.read(bstr, { type: 'binary' });
      const wsname = wb.SheetNames[0];
      const ws = wb.Sheets[wsname];
      const data = xlsx.utils.sheet_to_json(ws);

      // Flexible mapping
      const mappedData = data.map((row: any) => {
        const findKey = (patterns: string[]) => {
          const key = Object.keys(row).find(k => patterns.some(p => k.toLowerCase().includes(p.toLowerCase())));
          return key ? row[key] : undefined;
        };

        return {
          companyName: findKey(['company', 'name', 'exhibitor']) || 'Unknown',
          boothNumber: findKey(['booth', 'number', 'stand']),
          industry: findKey(['industry', 'sector', 'category']),
          estimatedRevenue: findKey(['revenue', 'income', 'sales']),
          employeeCount: findKey(['employee', 'count', 'size', 'staff']),
          notes: findKey(['notes', 'description', 'comment'])
        };
      });

      importMutation.mutate(mappedData);
    };
    reader.readAsBinaryString(file);
  };

  const filteredExhibitors = (Array.isArray(exhibitors) ? exhibitors : []).filter((ex: Exhibitor) => 
    ex.companyName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (ex.industry && ex.industry.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const shortlistedExhibitors = (Array.isArray(exhibitors) ? exhibitors : []).filter((ex: Exhibitor) => ex.isShortlisted);

  return (
    <div className="min-h-screen pb-24 max-w-md mx-auto relative">
      {/* Header */}
      <header className="px-8 pt-8 pb-6 relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-gold/5 to-transparent pointer-events-none" />
        
        <div className="flex items-center gap-5">
          <Logo />
          <div className="flex-1">
            <div className="flex items-center gap-4">
              <motion.h1 
                initial={{ x: -20, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                className="text-2xl font-black tracking-tighter gold-text uppercase italic leading-none whitespace-nowrap"
              >
                CONFERENCE COPILOT
              </motion.h1>
              <div className="h-px flex-1 bg-gradient-to-r from-gold/50 to-transparent relative">
                <div className="absolute -left-1 -top-1 w-2 h-2 border-l border-t border-gold/50" />
              </div>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <div className="w-2 h-2 bg-gold rounded-full" />
              <p className="mono-label !text-gold/60">
                {selectedConference ? `System Active: ${selectedConference.name}` : 'Awaiting Event Selection'}
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="px-8">
        {activeTab === 'conferences' && (
          <div className="space-y-8">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-black uppercase italic tracking-tight">Events Portal</h2>
              <button 
                onClick={() => setIsCreateModalOpen(true)}
                className="p-3 bg-gold/10 text-gold rounded-xl border border-gold/30 active:scale-90 transition-transform"
              >
                <Plus size={20} />
              </button>
            </div>
            
            <CreateConferenceModal 
              isOpen={isCreateModalOpen} 
              onClose={() => setIsCreateModalOpen(false)}
              onSubmit={(data) => createConfMutation.mutate(data)}
            />
            
            <div className="space-y-4">
              {loadingConfs ? (
                <div className="animate-pulse space-y-4">
                  {[1,2,3].map(i => <div key={`skeleton-conf-${i}`} className="h-20 bg-navy-card/20 rounded-2xl border border-white/5" />)}
                </div>
              ) : (
                (Array.isArray(conferences) ? conferences : []).map((conf: Conference, index: number) => (
                  <button 
                    key={conf.id || `conf-${index}`}
                    onClick={() => setSelectedConference(conf)}
                    className={cn(
                      "w-full text-left p-5 glass-card flex items-center justify-between group relative overflow-hidden",
                      selectedConference?.id === conf.id && "border-gold/40 bg-gold/5"
                    )}
                  >
                    {selectedConference?.id === conf.id && (
                      <div className="absolute top-0 left-0 w-1 h-full bg-gold" />
                    )}
                    <div>
                      <h3 className="font-black uppercase italic text-lg">{conf.name}</h3>
                      <p className="mono-label mt-1 flex items-center gap-1.5 leading-none">
                        <MapPin size={12} className="text-gold/60" /> 
                        <span className="leading-none translate-y-[1px]">{conf.location || 'Sector: Unknown'}</span>
                      </p>
                      {conf.date && (
                        <p className="mono-label mt-0.5 opacity-50 flex items-center gap-1.5 leading-none">
                          <Calendar size={12} className="text-gold/30" />
                          <span className="leading-none translate-y-[1px]">{new Date(conf.date).toLocaleDateString()}</span>
                        </p>
                      )}
                    </div>
                    <ChevronDown size={20} className="-rotate-90 text-slate-700 group-hover:text-gold transition-all duration-300" />
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'exhibitors' && (
          <div className="space-y-8">
            {!selectedConference ? (
              <div className="text-center py-24 space-y-6">
                <div className="relative inline-block">
                  <Building2 size={64} className="mx-auto text-slate-800" />
                  <div className="absolute inset-0 bg-gold/10 blur-2xl rounded-full" />
                </div>
                <p className="mono-label">No active event uplink detected</p>
                <button onClick={() => setActiveTab('conferences')} className="gold-button">Initialize Link</button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <div className="flex-1 relative">
                    <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input 
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="SEARCH EXHIBITORS..."
                      className="w-full bg-navy-card/30 border border-white/5 rounded-2xl py-4 pl-12 pr-4 text-xs font-mono uppercase tracking-widest focus:border-gold/40 outline-none transition-all duration-300"
                    />
                  </div>
                  <label className="shrink-0 p-4 bg-gold/10 text-gold rounded-2xl border border-gold/20 cursor-pointer active:scale-90 transition-all gold-glow">
                    <Upload size={20} />
                    <input type="file" className="hidden" accept=".xlsx, .xls" onChange={handleFileUpload} />
                  </label>
                </div>

                <div className="space-y-4">
                  {loadingExhibitors ? (
                    <div className="animate-pulse space-y-4">
                      {[1,2,3,4].map(i => <div key={`skeleton-ex-${i}`} className="h-24 bg-navy-card/20 rounded-2xl border border-white/5" />)}
                    </div>
                  ) : filteredExhibitors.length > 0 ? (
                    filteredExhibitors.map((ex: Exhibitor, index: number) => (
                      <ExhibitorCard key={ex.id || `ex-${index}`} exhibitor={ex} />
                    ))
                  ) : (
                    <div className="text-center py-16">
                      <p className="mono-label opacity-40">
                        {searchQuery ? 'Zero matches in local cache' : 'Database empty. Initiate import sequence.'}
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'contacts' && (
          <div className="space-y-8">
            {!selectedConference ? (
              <div className="text-center py-24 space-y-6">
                <div className="relative inline-block">
                  <ContactIcon size={64} className="mx-auto text-slate-800" />
                  <div className="absolute inset-0 bg-gold/10 blur-2xl rounded-full" />
                </div>
                <p className="mono-label">No active event uplink detected</p>
                <button onClick={() => setActiveTab('conferences')} className="gold-button">Initialize Link</button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-black uppercase italic tracking-tight">Intelligence Network</h2>
                  <button 
                    onClick={() => {
                      setEditingContact(null);
                      setIsContactModalOpen(true);
                    }}
                    className="p-3 bg-gold/10 text-gold rounded-xl border border-gold/30 active:scale-90 transition-transform"
                  >
                    <Plus size={20} />
                  </button>
                </div>

                <ContactModal 
                  isOpen={isContactModalOpen} 
                  onClose={() => {
                    setIsContactModalOpen(false);
                    setEditingContact(null);
                  }}
                  onSubmit={handleContactSubmit}
                  initialData={editingContact}
                  title={editingContact ? "Edit Contact" : "New Contact"}
                />

                <div className="space-y-4">
                  {loadingContacts ? (
                    <div className="animate-pulse space-y-4">
                      {[1,2,3].map(i => <div key={`skeleton-contact-${i}`} className="h-24 bg-navy-card/20 rounded-2xl border border-white/5" />)}
                    </div>
                  ) : (Array.isArray(contacts) && contacts.length > 0) ? (
                    contacts.map((contact: Contact, index: number) => (
                      <ContactCard 
                        key={contact.id || `contact-${index}`} 
                        contact={contact} 
                        onEdit={(c) => {
                          setEditingContact(c);
                          setIsContactModalOpen(true);
                        }}
                      />
                    ))
                  ) : (
                    <div className="text-center py-16">
                      <p className="mono-label opacity-40">No contacts registered for this event.</p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'shortlist' && (
          <div className="space-y-8">
            <h2 className="text-xl font-black uppercase italic tracking-tight">Priority Targets</h2>
            <div className="space-y-4">
              {shortlistedExhibitors.length > 0 ? (
                shortlistedExhibitors.map((ex: Exhibitor, index: number) => (
                  <ExhibitorCard key={`shortlist-${ex.id || index}`} exhibitor={ex} />
                ))
              ) : (
                <div className="text-center py-24 space-y-6">
                  <div className="relative inline-block">
                    <Star size={64} className="mx-auto text-slate-800" />
                    <div className="absolute inset-0 bg-gold/10 blur-2xl rounded-full" />
                  </div>
                  <p className="mono-label">No priority targets flagged</p>
                  <button onClick={() => setActiveTab('exhibitors')} className="gold-button">Scan Exhibitors</button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      <BottomNav activeTab={activeTab} setActiveTab={setActiveTab} />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  );
}
