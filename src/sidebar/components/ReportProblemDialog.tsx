import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Box,
  Typography,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Chip,
  CircularProgress,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  ReportProblem as ReportProblemIcon,
} from '@mui/icons-material';
import { messageService } from '#services/MessageService';

interface ConsoleLogEntry {
  level: string;
  message: string;
  timestamp: string;
}

interface ReportProblemDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (caseUrl: string) => void;
  onError: (message: string) => void;
}

const LEVEL_COLORS: Record<string, 'error' | 'warning' | 'default' | 'info'> = {
  error: 'error',
  warn: 'warning',
  info: 'info',
  log: 'default',
};

const ReportProblemDialog: React.FC<ReportProblemDialogProps> = ({
  open,
  onClose,
  onSuccess,
  onError,
}) => {
  const [description, setDescription] = useState('');
  const [pageUrl, setPageUrl] = useState('');
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;

    setDescription('');

    // Get the current tab URL
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      setPageUrl(tab?.url ?? '');
    });

    // Fetch console logs from the injected script via the action pipeline
    setLoadingLogs(true);
    messageService
      .sendMessage('navigation:get-console-logs')
      .then(response => {
        if (response.success && Array.isArray(response.data)) {
          setConsoleLogs(response.data as ConsoleLogEntry[]);
        } else {
          setConsoleLogs([]);
        }
      })
      .catch(() => setConsoleLogs([]))
      .finally(() => setLoadingLogs(false));
  }, [open]);

  const handleSubmit = async () => {
    if (!description.trim()) return;

    setSubmitting(true);
    try {
      const response = await messageService.sendMessage('navigation:report-problem', {
        description: description.trim(),
        url: pageUrl,
        consoleLogs,
      });

      if (response.success) {
        const caseUrl = (response.data as string) ?? '';
        onSuccess(caseUrl);
        onClose();
      } else {
        onError(response.error ?? 'Failed to create case');
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth='sm' fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <ReportProblemIcon color='warning' fontSize='small' />
        Report a Problem
      </DialogTitle>

      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
        <TextField
          label='Page URL'
          value={pageUrl}
          onChange={e => setPageUrl(e.target.value)}
          size='small'
          fullWidth
          multiline
          maxRows={3}
          slotProps={{ input: { readOnly: false } }}
        />

        <TextField
          label='Description *'
          value={description}
          onChange={e => setDescription(e.target.value)}
          size='small'
          fullWidth
          multiline
          rows={4}
          placeholder='Describe the problem you encountered…'
          autoFocus
        />

        <Accordion disableGutters elevation={0} sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant='body2' fontWeight={500}>
                Console Log
              </Typography>
              {loadingLogs ? (
                <CircularProgress size={14} />
              ) : (
                <Chip label={consoleLogs.length} size='small' sx={{ height: 18, fontSize: '0.7rem' }} />
              )}
            </Box>
          </AccordionSummary>
          <AccordionDetails sx={{ p: 0 }}>
            <Box
              component='pre'
              sx={{
                m: 0,
                p: 1.5,
                fontSize: '0.7rem',
                fontFamily: 'monospace',
                overflowY: 'auto',
                maxHeight: 180,
                bgcolor: 'action.hover',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {consoleLogs.length === 0 ? (
                <Typography variant='caption' color='text.secondary'>
                  {loadingLogs ? 'Loading…' : 'No console entries captured.'}
                </Typography>
              ) : (
                consoleLogs.map((entry, i) => (
                  <Box key={i} component='span' sx={{ display: 'block' }}>
                    <Chip
                      label={entry.level.toUpperCase()}
                      size='small'
                      color={LEVEL_COLORS[entry.level] ?? 'default'}
                      sx={{ height: 16, fontSize: '0.6rem', mr: 0.5, verticalAlign: 'middle' }}
                    />
                    <Typography component='span' variant='caption' color='text.secondary' sx={{ mr: 0.5 }}>
                      {entry.timestamp.substring(11, 23)}
                    </Typography>
                    {entry.message}
                  </Box>
                ))
              )}
            </Box>
          </AccordionDetails>
        </Accordion>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant='contained'
          color='warning'
          onClick={handleSubmit}
          disabled={!description.trim() || submitting}
          startIcon={submitting ? <CircularProgress size={14} color='inherit' /> : undefined}
        >
          {submitting ? 'Creating Case…' : 'Submit Case'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ReportProblemDialog;
