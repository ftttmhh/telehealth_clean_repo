const express = require('express');
const twilio = require('twilio');
const { OpenAI } = require('openai');
require('dotenv').config();

// Add this utility function for exponential backoff
const retryWithExponentialBackoff = async (operation, maxRetries = 5) => {
  console.log(`[DEBUG] Starting retry mechanism with max ${maxRetries} retries`);
  let retries = 0;
  
  while (true) {
    try {
      console.log(`[DEBUG] Executing operation, attempt ${retries + 1}`);
      const result = await operation();
      console.log(`[DEBUG] Operation succeeded on attempt ${retries + 1}`);
      return result;
    } catch (error) {
      retries++;
      console.log(`[DEBUG] Error on attempt ${retries}: ${error.message}`);
      console.log(`[DEBUG] Error type: ${error.constructor.name}`);
      
      if (error.response) {
        console.log(`[DEBUG] Response status: ${error.response.status}`);
        console.log(`[DEBUG] Response text: ${await error.response.text().catch(e => 'Could not read response text')}`);
      }
      
      // Check specifically for rate limit errors
      const isRateLimit = error.message.includes('429') || 
                        error.message.includes('rate') || 
                        error.message.includes('limit') ||
                        error.message.includes('too many');
                        
      console.log(`[DEBUG] Is rate limit error? ${isRateLimit}`);
      
      if (retries > maxRetries || !isRateLimit) {
        console.log(`[DEBUG] Giving up after ${retries} retries. Max retries: ${maxRetries}. Is rate limit? ${isRateLimit}`);
        throw error; // Rethrow if not a rate limit error or max retries reached
      }
      
      // Calculate delay with exponential backoff and jitter
      const delay = Math.min(
        100 * Math.pow(2, retries) + Math.random() * 100,
        2000 // Cap at 2 seconds max delay
      );
      
      console.log(`[DEBUG] Rate limited. Retrying in ${delay}ms (Attempt ${retries}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      console.log(`[DEBUG] Delay completed, proceeding to next attempt`);
    }
  }
};

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Add this near the top of your file after initializing OpenAI
console.log(`[DEBUG] OpenAI API Key length: ${process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.length : 'not set'}`);
console.log(`[DEBUG] OpenAI API Key first 4 chars: ${process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.substring(0, 4) : 'not set'}`);

// Optional: Test if the OpenAI object is properly initialized
try {
  const models = await openai.models.list();
  console.log(`[DEBUG] OpenAI connection successful, found ${models.data.length} models`);
} catch (e) {
  console.error(`[DEBUG] OpenAI initialization error: ${e.message}`);
}

// TwiML response for Twilio
app.post('/voice', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  
  // Start streaming with WebSockets
  twiml.connect().stream({
    url: `wss://${req.headers.host}/stream`,
    track: 'both_tracks',
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle callback calls
app.post('/handle-call', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  
  // Welcome message
  twiml.say({
    voice: 'alice'
  }, 'Welcome to the telehealth AI assistant. I will analyze your symptoms and provide preliminary medical guidance. Please describe your health concern after the beep.');
  
  // Record the user's health concern
  twiml.record({
    action: '/process-recording',
    transcribe: false,
    maxLength: 30,
    playBeep: true,
    timeout: 2
  });
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Process the recording
app.post('/process-recording', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  
  try {
    // Get the recording URL
    const recordingUrl = req.body.RecordingUrl;
    
    if (!recordingUrl) {
      twiml.say('I did not receive a recording. Please try again later.');
      res.type('text/xml');
      return res.send(twiml.toString());
    }
    
    console.log('Recording URL:', recordingUrl);
    
    // Fetch the audio file with retry
    let response, arrayBuffer;
    try {
      // Use function to fetch with retry
      const fetchData = async () => {
        const { default: nodeFetch } = await import('node-fetch');
        const resp = await nodeFetch(recordingUrl);
        const buffer = await resp.arrayBuffer();
        return { response: resp, arrayBuffer: buffer };
      };
      
      const result = await retryWithExponentialBackoff(fetchData);
      response = result.response;
      arrayBuffer = result.arrayBuffer;
    } catch (fetchError) {
      console.error("Error fetching audio:", fetchError);
      throw fetchError;
    }
    
    // Call OpenAI API directly with retry
    // Call OpenAI API directly with retry
console.log('[DEBUG] Starting OpenAI transcription with retry');
let transcriptionResult;
try {
  transcriptionResult = await retryWithExponentialBackoff(async () => {
    console.log('[DEBUG] Inside retry callback function');
    
    const { default: nodeFetch } = await import('node-fetch');
    console.log('[DEBUG] Fetched node-fetch');
    
    // Set a longer timeout for the API call
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log('[DEBUG] Request timeout triggered after 30 seconds');
      controller.abort();
    }, 30000); // 30 second timeout
    
    try {
      console.log('[DEBUG] Creating form for OpenAI');
      // Create a new FormData for each attempt
      const FormData = await import('form-data');
      const newForm = new FormData.default();
      
      // Create a fresh readable stream for each attempt
      const { Readable } = await import('stream');
      const newAudioStream = new Readable();
      newAudioStream.push(Buffer.from(arrayBuffer));
      newAudioStream.push(null);
      
      newForm.append('file', newAudioStream, {
        filename: 'recording.wav',
        contentType: 'audio/wav',
      });
      newForm.append('model', 'whisper-1');
      console.log('[DEBUG] Form prepared for OpenAI');
      
      console.log('[DEBUG] Sending request to OpenAI');
      // Make the actual API call with timeout
      const openaiResponse = await nodeFetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...newForm.getHeaders(),
        },
        body: newForm,
        signal: controller.signal
      });
      
      console.log(`[DEBUG] Received response from OpenAI: ${openaiResponse.status}`);
      
      if (!openaiResponse.ok) {
        const errorText = await openaiResponse.text().catch(e => 'Could not read error text');
        console.log(`[DEBUG] Error response: ${errorText}`);
        throw new Error(`OpenAI API error: ${openaiResponse.status} ${openaiResponse.statusText} - ${errorText}`);
      }
      
      const responseJson = await openaiResponse.json();
      console.log(`[DEBUG] Successfully parsed response: ${JSON.stringify(responseJson).substring(0, 100)}...`);
      return responseJson;
    } finally {
      clearTimeout(timeoutId); // Clear the timeout
      console.log('[DEBUG] Cleared timeout');
    }
  }, 5);
  
  console.log('[DEBUG] Transcription completed successfully');
} catch (transcriptionError) {
  console.error('[DEBUG] Final transcription error:', transcriptionError);
  
  // Use fallback response when OpenAI is rate limited
  if (transcriptionError.message.includes('429')) {
    twiml.say({
      voice: 'alice'
    }, "I'm experiencing high demand right now and couldn't process your request. Please try again in a few moments.");
    res.type('text/xml');
    return res.send(twiml.toString());
  }
  
  throw transcriptionError; // Re-throw to be caught by outer catch
}
    
    const text = transcriptionResult && transcriptionResult.text ? transcriptionResult.text : '';
    
    if (!text) {
      console.log('[DEBUG] No text transcribed from audio');
      twiml.say('I couldn\'t understand what you said. Please try again.');
      res.type('text/xml');
      return res.send(twiml.toString());
    }
    
    console.log('Transcription:', text);
    
    // Generate medical advice with retry
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.log('[DEBUG] Chat completion timeout triggered after 20 seconds');
        controller.abort();
      }, 20000);
      
      try {
        const completion = await retryWithExponentialBackoff(async () => {
          return openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
              {
                role: 'system',
                content: 'You are a helpful telehealth assistant. Provide brief, accurate medical guidance based on symptoms described. Always include a disclaimer that this is not a replacement for professional medical advice.'
              },
              { role: 'user', content: text }
            ],
            max_tokens: 150,
          });
        });
        
        // Read the response to the user
        const aiResponse = completion.choices[0].message.content;
        twiml.say({
          voice: 'alice'
        }, aiResponse);
      } catch (chatError) {
        console.error('[DEBUG] Chat completion error:', chatError);
        
        // Use fallback for rate limiting or timeouts
        twiml.say({
          voice: 'alice'
        }, "I'm having trouble generating a detailed response right now. For your symptoms, general advice would be to rest, stay hydrated, and consult with a healthcare professional if symptoms persist. This is not a replacement for professional medical advice.");
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      console.error('Error generating medical advice:', error);
      twiml.say('I apologize, but I encountered an error. Please try again later.');
    }
    
  } catch (error) {
    console.error('Error processing recording:', error);
    twiml.say('I apologize, but I encountered an error. Please try again later.');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Set up WebSocket server for streaming audio
const http = require('http');
const server = http.createServer(app);
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server, path: '/stream' });

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('WebSocket connection established');
  
  let transcription = '';
  let openaiStream;
  
  // Set up OpenAI Audio Transcription
  const setupOpenAI = async () => {
    // Create an OpenAI streaming connection for real-time audio processing
    openaiStream = await openai.audio.streamingTranscriptions.create({
      model: 'whisper-1',
      language: 'en',
      onMessage: (message) => {
        const transcriptionResult = JSON.parse(message);
        if (transcriptionResult.text) {
          transcription += transcriptionResult.text + ' ';
          console.log('Transcription:', transcriptionResult.text);
          
          // If we have enough text, send to OpenAI for processing
          if (transcription.split(' ').length > 5) {
            processTranscription(transcription);
            transcription = ''; // Reset for next chunk
          }
        }
      },
    });
  };
  
  // Process transcription with OpenAI for medical advice
  const processTranscription = async (text) => {
    try {
      const completion = await retryWithExponentialBackoff(async () => {
        return openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: 'You are a helpful telehealth assistant. Provide brief, accurate medical guidance based on symptoms described. Always include a disclaimer that this is not a replacement for professional medical advice.'
            },
            { role: 'user', content: text }
          ],
          max_tokens: 150,
        });
      });
      
      // Send the AI response back to the user
      const aiResponse = completion.choices[0].message.content;
      
      // Convert text to speech and send back to user
      const audioResponse = await retryWithExponentialBackoff(async () => {
        return openai.audio.speech.create({
          model: 'tts-1',
          voice: 'alloy',
          input: aiResponse,
        });
      });
      
      // Convert audio buffer to base64 and send to client
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
      ws.send(JSON.stringify({
        type: 'audio',
        audio: audioBuffer.toString('base64'),
      }));
      
    } catch (error) {
      console.error('Error processing transcription:', error);
    }
  };
  
  setupOpenAI();
  
  // Handle incoming audio data
  ws.on('message', (data) => {
    if (openaiStream) {
      openaiStream.write(data);
    }
  });
  
  // Handle connection close
  ws.on('close', () => {
    console.log('WebSocket connection closed');
    if (openaiStream) {
      openaiStream.end();
    }
  });
});

// Import and use the callback router
const callbackRouter = require('./callback');
app.use('/api', callbackRouter);

// Start the server
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

// Export utility functions
module.exports = {
  app,
  server, 
  retryWithExponentialBackoff
};