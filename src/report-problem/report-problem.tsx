import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Box,
  Button,
  Typography,
  TextField,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Chip,
  CircularProgress,
  Alert,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  ReportProblem as ReportProblemIcon,
} from '@mui/icons-material';
import { ThemeProvider } from '#contexts/ThemeContext';
import { messageService } from '#services/MessageService';

interface ConsoleLogEntry {
  level: string;
  message: string;
  timestamp: string;
}

const LEVEL_COLORS: Record<string, 'error' | 'warning' | 'default' | 'info'> = {
  error: 'error',
  warn: 'warning',
  info: 'info',
  log: 'default',
};

const ReportProblemPage: React.FC = () => {
  const [description, setDescription] = useState('');
  const [pageUrl, setPageUrl] = useState('');
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [resultMessage, setResultMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    // Get the URL from the opener tab (passed via storage)
    chrome.storage.session.get('reportProblemTabUrl').then(result => {
      setPageUrl((result.reportProblemTabUrl as string) ?? '');
    });

    // Fetch console logs
    messageService
      .sendMessage('navigation:get-console-logs')
      .then(response => {
        if (response.success && Array.isArray(response.data)) {
          setConsoleLogs(response.data as ConsoleLogEntry[]);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingLogs(false));
  }, []);

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
        setResultMessage({ type: 'success', text: 'Support case created successfully.' });
        if (caseUrl.startsWith('http')) {
          setTimeout(() => {
            chrome.tabs.create({ url: caseUrl });
            window.close();
          }, 1200);
        } else {
          setTimeout(() => window.close(), 1500);
        }
      } else {
        setResultMessage({ type: 'error', text: response.error ?? 'Failed to create case.' });
      }
    } catch (error) {
      setResultMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        bgcolor: 'background.default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 3,
      }}
    >
      <Box
        sx={{
          width: '100%',
          maxWidth: 640,
          bgcolor: 'background.paper',
          borderRadius: 2,
          boxShadow: 6,
          p: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 2.5,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <ReportProblemIcon color='warning' fontSize='large' />
          <Typography variant='h5' fontWeight={600}>
            Report a Problem
          </Typography>
        </Box>

        {resultMessage && <Alert severity={resultMessage.type}>{resultMessage.text}</Alert>}

        <TextField
          label='Page URL'
          value={pageUrl}
          onChange={e => setPageUrl(e.target.value)}
          size='small'
          fullWidth
          multiline
          maxRows={3}
        />

        <TextField
          label='Description *'
          value={description}
          onChange={e => setDescription(e.target.value)}
          size='small'
          fullWidth
          multiline
          rows={6}
          placeholder='Describe the problem you encountered…'
          autoFocus
        />

        <Accordion
          disableGutters
          elevation={0}
          sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}
        >
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant='body2' fontWeight={500}>
                Console Log
              </Typography>
              {loadingLogs ? (
                <CircularProgress size={14} />
              ) : (
                <Chip
                  label={consoleLogs.length}
                  size='small'
                  sx={{ height: 18, fontSize: '0.7rem' }}
                />
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
                maxHeight: 240,
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
                    <Typography
                      component='span'
                      variant='caption'
                      color='text.secondary'
                      sx={{ mr: 0.5 }}
                    >
                      {entry.timestamp.substring(11, 23)}
                    </Typography>
                    {entry.message}
                  </Box>
                ))
              )}
            </Box>
          </AccordionDetails>
        </Accordion>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1.5, pt: 1 }}>
          <Button onClick={() => window.close()} disabled={submitting}>
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
        </Box>
      </Box>
    </Box>
  );
};

const container = document.getElementById('report-problem-root');
if (container) {
  const root = createRoot(container);
  root.render(
    <ThemeProvider>
      <ReportProblemPage />
    </ThemeProvider>
  );
}
