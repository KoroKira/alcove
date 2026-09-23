import React, { useEffect, useRef } from 'react';
import './HtmlPreview.scss';
import { DEFAULT_HTML_PREVIEW_API_PATHS, isAllowedHtmlApiRequest } from './htmlPreviewSecurity';

// Message passing script to be injected into the iframe
const messagePassingScript = `
<script>
  window.callApi = function(endpoint, method, data) {
  const requestId = 'req_' + Math.random().toString(36).substring(2, 15);
  
  window.parent.postMessage({
    type: 'API_REQUEST',
    endpoint: endpoint,
    method: method || 'GET',
    data: data,
    requestId: requestId
  }, '*');
  
  // Return a promise that will be resolved when the parent responds
  return new Promise((resolve, reject) => {
    window.apiCallbacks = window.apiCallbacks || {};
    window.apiCallbacks[requestId] = {resolve, reject};
  });
};

// Listen for responses from the parent
window.addEventListener('message', function(event) {
  if (event.source === window.parent && event.data?.type === 'API_RESPONSE' &&
      window.apiCallbacks && 
      window.apiCallbacks[event.data.requestId]) {
    if (event.data.error) {
      window.apiCallbacks[event.data.requestId].reject(event.data.error);
    } else {
      window.apiCallbacks[event.data.requestId].resolve(event.data.data);
    }
    delete window.apiCallbacks[event.data.requestId];
  }
});
</script>
`;

interface HtmlPreviewProps {
  htmlContent: string;
  className?: string;
  allowedApiPaths?: readonly string[];
}

const HtmlPreview: React.FC<HtmlPreviewProps> = ({ 
  htmlContent, 
  className = 'html-preview__container',
  allowedApiPaths = DEFAULT_HTML_PREVIEW_API_PATHS,
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  
  // Handle API requests from the iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const iframeWindow = iframeRef.current?.contentWindow;
      if (!iframeWindow || !isAllowedHtmlApiRequest(event.data, event.source, iframeWindow, window.location.origin, allowedApiPaths)) {
        return;
      }

      // The bridge is intentionally read-only. A rendered pad must never be
      // able to perform arbitrary authenticated state changes as its viewer.
      fetch(event.data.endpoint, {
          method: 'GET',
          credentials: 'include', // This includes the current viewer's cookies
        })
        .then(response => {
          if (!response.ok) throw new Error('API request failed');
          return response.json();
        })
        .then(data => {
          // Send successful response back to iframe
          if (iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage({
              type: 'API_RESPONSE',
              requestId: event.data.requestId,
              data: data
            }, '*');
          }
        })
        .catch(error => {
          // Send error back to iframe
          if (iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage({
              type: 'API_RESPONSE',
              requestId: event.data.requestId,
              error: error.message
            }, '*');
          }
        });
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [allowedApiPaths]);

  // Prepare the HTML content with the message passing script
  const prepareHtmlContent = () => {
    // Insert the message passing script before the closing body tag
    // If there's no body tag, append it to the end
    if (htmlContent.includes('</body>')) {
      return htmlContent.replace('</body>', `${messagePassingScript}</body>`);
    } else {
      return `${htmlContent}${messagePassingScript}`;
    }
  };

  return (
    <div className={className}>
      <iframe 
        ref={iframeRef}
        className="html-preview__iframe"
        sandbox="allow-scripts"
        srcDoc={prepareHtmlContent()}
        title="HTML Preview"
      />
    </div>
  );
};

export default HtmlPreview;
