import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { log } from "../middleware/logger";
import { ClientManager } from "../core/ClientManager";
import { Client } from "../core/Client"; // Import Client type
import axios from 'axios';
import { PassThrough } from 'stream';
import { JSDOM } from 'jsdom';
import { User } from '../models/user';
import { authMiddleware, trackApiUsage } from '../middleware/auth';
import * as bcrypt from 'bcryptjs';
import crypto from 'crypto';

// Add this helper function at the top of your file
function safeResponse(res: Response, statusCode: number, data: any): void {
  if (!res.headersSent) {
    res.status(statusCode).json(data);
  } else {
    log.warn("Attempted to send response after headers sent", { data });
  }
}

export const apiRoutes = (app: express.Application): void => {
  // Setup handlers for storing search results and entity data from WebSocket
  setupMessageHandlers();
  
  // Create a router instead of using app directly
  const router = express.Router();

  // Define routes on the router
  router.get("/", (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, "../../_test/test-client.html"));
  });

  router.get("/health", (req: Request, res: Response) => {
    res.json({
      status: "ok",
      instance: process.env.FLY_MACHINE_ID,
    });
    return;
  });

  router.get("/api/status", (req: Request, res: Response) => {
    res.json({ 
      status: "ok",
      version: "1.0.0",
      websocket: "/relay"
    });
  });

  // User registration
  router.post('/register', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;
      
      console.log(`Registration attempt for: ${email}`);
      
      if (!email || !password) {
        console.log('Missing email or password');
        safeResponse(res, 400, { error: 'Email and password are required' });
        return;
      }
      
      // Check if user already exists
      const existingUser = await User.findOne({ where: { email } });
      if (existingUser) {
        console.log(`User already exists: ${email}`);
        safeResponse(res, 409, { error: 'User already exists' });
        return;
      }
      
      console.log('Creating new user...');
      // Create a new user
      const user = await User.create({
        email,
        password, // Will be hashed by the beforeCreate hook
        apiKey: crypto.randomBytes(16).toString('hex'), // Explicitly generate an API key
        requestsThisMonth: 0
      });
      
      console.log(`User created: ${user.getDataValue('email')} with API key: ${user.getDataValue('apiKey')}`);
      
      // Return the user (exclude password)
      safeResponse(res, 201, {
        id: user.getDataValue('id'),
        email: user.getDataValue('email'),
        apiKey: user.getDataValue('apiKey'),
        createdAt: user.getDataValue('createdAt'),
        subscriptionStatus: user.getDataValue('subscriptionStatus') || 'free'
      });
      return;
    } catch (error) {
      console.error('Registration error:', error);
      safeResponse(res, 500, { error: 'Registration failed' });
      return;
    }
  });

  // Get all connected clients
  router.get("/clients", authMiddleware, (req: Request, res: Response) => {
    const apiKey = req.header('x-api-key');
    const clients = ClientManager.getConnectedClients(apiKey);
    
    safeResponse(res, 200, {
      total: clients.length,
      clients
    });
  });
  
  // Search endpoint that relays to Foundry's Quick Insert
  router.get("/search", authMiddleware, trackApiUsage, async (req: Request, res: Response) => {
    const query = req.query.query as string;
    const filter = req.query.filter as string;
    const clientId = req.query.clientId as string;
    
    if (!query) {
      safeResponse(res, 400, { 
        error: "Query parameter is required",
        howToUse: "Add ?query=yourSearchTerm to your request"
      });
      return;
    }
    
    if (!clientId) {
      safeResponse(res, 400, { 
        error: "Client ID is required to identify the Foundry instance",
        howToUse: "Add &clientId=yourClientId to your request",
        tip: "Get a list of available client IDs at /clients"
      });
      return;
    }
    
    // Find a connected client with this ID
    const client = ClientManager.getClient(clientId);
    if (!client) {
      safeResponse(res, 404, { 
        error: "Invalid client ID",
        tip: "Get a list of available client IDs at /clients"
      });
      return;
    }
    
    try {
      // Generate a unique requestId for this search
      const requestId = `search_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      // Store the response object in a request map
      pendingRequests.set(requestId, { 
        res,
        type: 'search',
        clientId,
        query: query,
        filter: filter,
        timestamp: Date.now() 
      });
      
      // Send request to Foundry for search
      const sent = client.send({
        type: "perform-search",
        query,
        filter: filter || null,
        requestId
      });

      if (!sent) {
        pendingRequests.delete(requestId);
        safeResponse(res, 500, { 
          error: "Failed to send search request to Foundry client",
          suggestion: "The client may be disconnecting or experiencing issues"  
        });
        return;
      }
      
      // Set timeout for request
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          safeResponse(res, 408, { 
            error: "Search request timed out", 
            tip: "The Foundry client might be busy or still building its index."
          });
        }
      }, 10000); // 10 seconds timeout
      
    } catch (error) {
      log.error(`Error processing search request: ${error}`);
      safeResponse(res, 500, { error: "Failed to process search request" });
      return;
    }
  });

  // Get entity by UUID
  router.get("/get/:uuid", authMiddleware, trackApiUsage, async (req: Request, res: Response) => {
    const uuid = req.params.uuid;
    const clientId = req.query.clientId as string;
    const noCache = req.query.noCache === 'true';
    
    if (!uuid) {
      safeResponse(res, 400, { error: "UUID parameter is required" });
      return;
    }
    
    if (!clientId) {
      safeResponse(res, 400, { 
        error: "Client ID is required to identify the Foundry instance",
        howToUse: "Add &clientId=yourClientId to your request",
        tip: "Get a list of available client IDs at /clients"
      });
      return;
    }
    
    // Find a connected client with this ID
    const client = ClientManager.getClient(clientId);
    if (!client) {
      safeResponse(res, 404, { 
        error: "Invalid client ID",
        tip: "Get a list of available client IDs at /clients"
      });
      return;
    }
    
    try {
      // Generate a unique requestId for this entity request
      const requestId = `entity_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      // Store the response object in a request map
      pendingRequests.set(requestId, { 
        res,
        type: 'entity',
        uuid,
        timestamp: Date.now() 
      });
      
      // Send request to Foundry for entity data
      const sent = client.send({
        type: "get-entity",
        uuid,
        requestId
      });

      if (!sent) {
        pendingRequests.delete(requestId);
        safeResponse(res, 500, { 
          error: "Failed to send entity request to Foundry client",
          suggestion: "The client may be disconnecting or experiencing issues"  
        });
        return;
      }
      
      // Set timeout for request
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          safeResponse(res, 408, { 
            error: "Entity request timed out", 
            tip: "The Foundry client might be busy or the UUID might not exist."
          });
        }
      }, 10000); // 10 seconds timeout
    } catch (error) {
      log.error(`Error processing entity request: ${error}`);
      safeResponse(res, 500, { error: "Failed to process entity request" });
      return;
    }
  });

  // Get all folders and compendiums
  router.get("/structure", authMiddleware, trackApiUsage, async (req: Request, res: Response) => {
    const clientId = req.query.clientId as string;
    
    if (!clientId) {
      safeResponse(res, 400, { 
        error: "Client ID is required",
        howToUse: "Add ?clientId=yourClientId to your request"
      });
			return;
    }
    
    const client = ClientManager.getClient(clientId);
    if (!client) {
      safeResponse(res, 404, { 
        error: "Invalid client ID"
      });
			return;
    }
    
    try {
      // Generate a unique requestId
      const requestId = `structure_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      pendingRequests.set(requestId, { 
        res,
        type: 'structure',
        clientId,
        timestamp: Date.now() 
      });
      
      const sent = client.send({
        type: "get-structure",
        requestId
      });

      if (!sent) {
        pendingRequests.delete(requestId);
        safeResponse(res, 500, { 
          error: "Failed to send structure request to Foundry client"
        });
			  return;
      }
      
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          safeResponse(res, 408, { error: "Request timed out" });
        }
      }, 10000);
    } catch (error) {
      log.error(`Error processing structure request: ${error}`);
      safeResponse(res, 500, { error: "Failed to process structure request" });
      return;
    }
  });

  // Get all entity UUIDs in a folder or compendium
  router.get("/contents/:path", authMiddleware, trackApiUsage, async (req: Request, res: Response) => {
    const path = req.params.path;
    const clientId = req.query.clientId as string;
    
    if (!clientId) {
      safeResponse(res, 400, { 
        error: "Client ID is required",
        howToUse: "Add ?clientId=yourClientId to your request"
      });
			return;
    }
    
    if (!path) {
      safeResponse(res, 400, { error: "Path parameter is required" });
      return;
    }
    
    const client = ClientManager.getClient(clientId);
    if (!client) {
      safeResponse(res, 404, { 
        error: "Invalid client ID"
      });
			return;
    }
    
    try {
      // Generate a unique requestId
      const requestId = `contents_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      pendingRequests.set(requestId, { 
        res,
        type: 'contents',
        clientId,
        path,
        timestamp: Date.now() 
      });
      
      const sent = client.send({
        type: "get-contents",
        path,
        requestId
      });

      if (!sent) {
        pendingRequests.delete(requestId);
        safeResponse(res, 500, { 
          error: "Failed to send contents request to Foundry client"
        });
			return;
      }
      
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          safeResponse(res, 408, { error: "Request timed out" });
        }
      }, 10000);
    } catch (error) {
      log.error(`Error processing contents request: ${error}`);
      safeResponse(res, 500, { error: "Failed to process contents request" });
      return;
    }
  });

  // Create a new entity
  router.post("/entity", authMiddleware, trackApiUsage, express.json(), async (req: Request, res: Response) => {
    const clientId = req.query.clientId as string;
    const { type, folder, data } = req.body;
    
    if (!clientId) {
      safeResponse(res, 400, { 
        error: "Client ID is required",
        howToUse: "Add ?clientId=yourClientId to your request" 
      });
			return;
    }
    
    if (!type || !data) {
      safeResponse(res, 400, { 
        error: "Request body must include 'type' and 'data' fields",
        example: { type: "Actor", folder: "Folder ID or null", data: { name: "Entity Name", /* other data */ } }
      });
			return;
    }
    
    const client = ClientManager.getClient(clientId);
    if (!client) {
      safeResponse(res, 404, { 
        error: "Invalid client ID"
      });
			return;
    }
    
    try {
      // Generate a unique requestId
      const requestId = `create_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      pendingRequests.set(requestId, { 
        res,
        type: 'create',
        clientId,
        timestamp: Date.now() 
      });
      
      const sent = client.send({
        type: "create-entity",
        entityType: type,
        folder: folder || null,
        data: data,
        requestId
      });

      if (!sent) {
        pendingRequests.delete(requestId);
        safeResponse(res, 500, { 
          error: "Failed to send create request to Foundry client"
        });
			  return;
      }
      
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          safeResponse(res, 408, { error: "Request timed out" });
        }
      }, 10000);
    } catch (error) {
      log.error(`Error processing create entity request: ${error}`);
      safeResponse(res, 500, { error: "Failed to process create entity request" });
      return;
    }
  });

  // Update an entity by UUID
  router.put("/entity/:uuid", authMiddleware, trackApiUsage, express.json(), async (req: Request, res: Response) => {
    const uuid = req.params.uuid;
    const clientId = req.query.clientId as string;
    const updateData = req.body;
    
    if (!clientId) {
      safeResponse(res, 400, { 
        error: "Client ID is required",
        howToUse: "Add ?clientId=yourClientId to your request"
      });
			return;
    }
    
    if (!uuid) {
      safeResponse(res, 400, { error: "UUID parameter is required" });
      return;
    }
    
    if (!updateData || Object.keys(updateData).length === 0) {
      safeResponse(res, 400, { error: "Update data is required in request body" });
      return;
    }
    
    const client = ClientManager.getClient(clientId);
    if (!client) {
      safeResponse(res, 404, { 
        error: "Invalid client ID"
      });
			return;
    }
    
    try {
      // Generate a unique requestId
      const requestId = `update_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      pendingRequests.set(requestId, { 
        res,
        type: 'update',
        clientId,
        uuid,
        timestamp: Date.now() 
      });
      
      const sent = client.send({
        type: "update-entity",
        uuid,
        updateData,
        requestId
      });

      if (!sent) {
        pendingRequests.delete(requestId);
        safeResponse(res, 500, { 
          error: "Failed to send update request to Foundry client"
        });
			return;
      }
      
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          safeResponse(res, 408, { error: "Request timed out" });
        }
      }, 10000);
    } catch (error) {
      log.error(`Error processing update entity request: ${error}`);
      safeResponse(res, 500, { error: "Failed to process update entity request" });
      return;
    }
  });

  // Delete an entity by UUID
  router.delete("/entity/:uuid", authMiddleware, trackApiUsage, async (req: Request, res: Response) => {
    const uuid = req.params.uuid;
    const clientId = req.query.clientId as string;
    
    if (!clientId) {
      safeResponse(res, 400, { 
        error: "Client ID is required",
        howToUse: "Add ?clientId=yourClientId to your request"
      });
			return;
    }
    
    if (!uuid) {
      safeResponse(res, 400, { error: "UUID parameter is required" });
      return;
    }
    
    const client = ClientManager.getClient(clientId);
    if (!client) {
      safeResponse(res, 404, { 
        error: "Invalid client ID"
      });
			return;
    }
    
    try {
      // Generate a unique requestId
      const requestId = `delete_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      pendingRequests.set(requestId, { 
        res,
        type: 'delete',
        clientId,
        uuid,
        timestamp: Date.now() 
      });
      
      const sent = client.send({
        type: "delete-entity",
        uuid,
        requestId
      });

      if (!sent) {
        pendingRequests.delete(requestId);
        safeResponse(res, 500, { 
          error: "Failed to send delete request to Foundry client"
        });
			  return;
      }
      
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          safeResponse(res, 408, { error: "Request timed out" });
        }
      }, 10000);
    } catch (error) {
      log.error(`Error processing delete entity request: ${error}`);
      safeResponse(res, 500, { error: "Failed to process delete entity request" });
      return;
    }
  });

  // Get recent rolls
  router.get("/rolls", authMiddleware, trackApiUsage, async (req: Request, res: Response) => {
    const clientId = req.query.clientId as string;
    const limit = parseInt(req.query.limit as string) || 20;
    
    if (!clientId) {
      safeResponse(res, 400, { 
        error: "Client ID is required",
        howToUse: "Add ?clientId=yourClientId to your request"
      });
			return;
    }
    
    const client = ClientManager.getClient(clientId);
    if (!client) {
      safeResponse(res, 404, { 
        error: "Invalid client ID"
      });
			return;
    }
    
    try {
      // Request from Foundry client
      const requestId = `rolls_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      pendingRequests.set(requestId, { 
        res,
        type: 'rolls',
        clientId,
        timestamp: Date.now() 
      });
      
      const sent = client.send({
        type: "get-rolls",
        limit,
        requestId
      });

      if (!sent) {
        pendingRequests.delete(requestId);
        safeResponse(res, 500, { 
          error: "Failed to send rolls request to Foundry client" 
        });
			  return;
      }
      
      // Set timeout for request
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          safeResponse(res, 404, { 
            error: "No roll data available",
            message: "Request timed out"
          });
        }
      }, 5000);
      
    } catch (error) {
      log.error(`Error processing rolls request: ${error}`);
      safeResponse(res, 500, { error: "Failed to process rolls request" });
      return;
    }
  });

  // Get last roll
  router.get("/lastroll", authMiddleware, trackApiUsage, async (req: Request, res: Response) => {
    const clientId = req.query.clientId as string;
    
    if (!clientId) {
      safeResponse(res, 400, { 
        error: "Client ID is required",
        howToUse: "Add ?clientId=yourClientId to your request"
      });
			return;
    }
    
    const client = ClientManager.getClient(clientId);
    if (!client) {
      safeResponse(res, 404, { 
        error: "Invalid client ID"
      });
			return;
    }
    
    try {
      // Request from Foundry client
      const requestId = `lastroll_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      pendingRequests.set(requestId, { 
        res,
        type: 'lastroll',
        clientId,
        timestamp: Date.now() 
      });
      
      const sent = client.send({
        type: "get-last-roll",
        requestId
      });

      if (!sent) {
        pendingRequests.delete(requestId);
        safeResponse(res, 500, { 
          error: "Failed to send last roll request to Foundry client" 
        });
			  return;
      }
      
      // Set timeout for request
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          safeResponse(res, 404, { 
            error: "No roll data available",
            message: "No dice have been rolled yet or request timed out"
          });
        }
      }, 5000);
      
    } catch (error) {
      log.error(`Error processing last roll request: ${error}`);
      safeResponse(res, 500, { error: "Failed to process last roll request" });
      return;
    }
  });

  // Create a new roll
  router.post("/roll", authMiddleware, trackApiUsage, express.json(), async (req: Request, res: Response) => {
    const clientId = req.query.clientId as string;
    const { formula, flavor, createChatMessage, whisper } = req.body;
    
    if (!clientId) {
      safeResponse(res, 400, { 
        error: "Client ID is required",
        howToUse: "Add ?clientId=yourClientId to your request"
      });
			return;
    }
    
    if (!formula) {
      safeResponse(res, 400, { 
        error: "Roll formula is required",
        example: { formula: "2d6+3", flavor: "Attack roll", createChatMessage: true }
      });
			return;
    }
    
    const client = ClientManager.getClient(clientId);
    if (!client) {
      safeResponse(res, 404, { 
        error: "Invalid client ID"
      });
			return;
    }
    
    try {
      // Generate a unique requestId
      const requestId = `roll_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      pendingRequests.set(requestId, { 
        res,
        type: 'roll',
        clientId,
        timestamp: Date.now() 
      });
      
      const sent = client.send({
        type: "perform-roll",
        formula,
        flavor,
        createChatMessage,
        whisper,
        requestId
      });

      if (!sent) {
        pendingRequests.delete(requestId);
        safeResponse(res, 500, { 
          error: "Failed to send roll request to Foundry client"
        });
			  return;
      }
      
      // Set timeout for request
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          safeResponse(res, 408, { error: "Request timed out" });
        }
      }, 5000);
      
    } catch (error) {
      log.error(`Error processing roll request: ${error}`);
      safeResponse(res, 500, { error: "Failed to process roll request" });
      return;
    }
  });

  // Get actor sheet HTML
  router.get("/sheet/:uuid", authMiddleware, trackApiUsage, async (req: Request, res: Response) => {
    const uuid = req.params.uuid;
    const clientId = req.query.clientId as string;
    const format = req.query.format as string || 'html';
    const initialScale = parseFloat(req.query.scale as string) || null;
    const activeTab = req.query.tab ? (isNaN(Number(req.query.tab)) ? null : Number(req.query.tab)) : null;
    const darkMode = req.query.darkMode === 'true';
    
    if (!clientId) {
      safeResponse(res, 400, { 
        error: "Client ID is required to identify the Foundry instance"
      });
			return;
    }
    
    // Find a connected client with this ID
    const client = ClientManager.getClient(clientId);
    if (!client) {
      safeResponse(res, 404, { 
        error: "Invalid client ID"
      });
			return;
    }
    
    try {
      // Generate a unique requestId for this request
      const requestId = `actor_sheet_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      // Store the response object in a request map
      pendingRequests.set(requestId, { 
        res,
        type: 'actor-sheet',
        uuid,
        clientId,
        format,
        initialScale,
        activeTab,
        darkMode,
        timestamp: Date.now() 
      });
      
      // Send request to Foundry for actor sheet HTML
      const sent = client.send({
        type: "get-sheet-html",
        uuid,
        requestId,
        initialScale,
        activeTab,
        darkMode
      });

      if (!sent) {
        pendingRequests.delete(requestId);
        safeResponse(res, 500, { 
          error: "Failed to send actor sheet request to Foundry client",
          suggestion: "The client may be disconnecting or experiencing issues"  
        });
        return;
      }
      
      // Set timeout for request
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          safeResponse(res, 408, { 
            error: "Actor sheet request timed out", 
            tip: "The Foundry client might be busy or the actor UUID might not exist."
          });
        }
      }, 10000); // 10 seconds timeout
      
    } catch (error) {
      log.error(`Error processing actor sheet request: ${error}`);
      safeResponse(res, 500, { error: "Failed to process actor sheet request" });
      return;
    }
  });
  
  // Add this route before mounting the router
  router.get('/proxy-asset/:path(*)', async (req: Request, res: Response) => {
    try {
      // Get the Foundry URL from the client metadata or use default
      const clientId = req.query.clientId as string;
      let foundryBaseUrl = 'http://localhost:30000'; // Default Foundry URL
      
      // If we have client info, use its URL
      if (clientId) {
        const client = ClientManager.getClient(clientId);
        if (client && 'metadata' in client && client.metadata && (client.metadata as any).origin) {
          foundryBaseUrl = (client.metadata as any).origin;
        }
      }
      
      const assetPath = req.params.path;
      const assetUrl = `${foundryBaseUrl}/${assetPath}`;
      
      log.debug(`Proxying asset request to: ${assetUrl}`);
      
      // Check if it's a Font Awesome file - redirect to CDN if so
      if (assetPath.includes('/webfonts/fa-') || assetPath.includes('/fonts/fontawesome/') || 
          assetPath.includes('/fonts/fa-')) {
        
        // Extract the filename
        const filename = assetPath.split('/').pop() || '';
        
        // Redirect to CDN
        const cdnUrl = `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/webfonts/${filename}`;
        log.debug(`Redirecting Font Awesome asset to CDN: ${cdnUrl}`);
        res.redirect(cdnUrl);
			  return;
      }
      
      // Check for texture files - use GitHub raw content as fallback
      if (assetPath.includes('texture1.webp') || assetPath.includes('texture2.webp') || 
          assetPath.includes('parchment.jpg')) {
        log.debug(`Serving texture file from GitHub fallback`);
        res.redirect('https://raw.githubusercontent.com/foundryvtt/dnd5e/master/ui/parchment.jpg');
			  return;
      }
      
      if (assetPath.includes('ac-badge')) {
        res.redirect('https://raw.githubusercontent.com/foundryvtt/dnd5e/master/ui/ac-badge.webp');
			  return;
      }
      
      if (assetPath.includes('cr-badge')) {
        res.redirect('https://raw.githubusercontent.com/foundryvtt/dnd5e/master/ui/cr-badge.webp');
			  return;
      }
      
      // Try to make the request to Foundry
      try {
        const response = await axios({
          method: 'get',
          url: assetUrl,
          responseType: 'stream',
          timeout: 5000
        });
        
        // Copy headers
        Object.keys(response.headers).forEach(header => {
          res.setHeader(header, response.headers[header]);
        });
        
        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        // Stream the response
        response.data.pipe(res);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.warn(`Failed to proxy asset from ${assetUrl}: ${errorMessage}`);
        
        // For image files, try to provide a fallback
        const ext = assetPath.split('.').pop()?.toLowerCase();
        if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext || '')) {
          // For images, send a transparent 1x1 pixel as fallback
          log.debug(`Sending fallback transparent image for: ${assetPath}`);
          res.setHeader('Content-Type', 'image/png');
          res.send(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
        } else {
          res.status(404).send('Asset not found');
        }
      }
    } catch (error) {
      log.error(`Error in proxy asset handler: ${error}`);
      res.status(404).send('Asset not found');
    }
  });

  // Mount the router
  app.use("/", router);
};

// Track pending requests
interface PendingRequest {
  res: express.Response;
  type: 'search' | 'entity' | 'structure' | 'contents' | 'create' | 'update' | 'delete' | 'rolls' | 'lastroll' | 'roll' | 'actor-sheet';
  clientId?: string;
  uuid?: string;
  path?: string;
  query?: string;
  filter?: string;
  timestamp: number;
  format?: string;
  initialScale?: number | null;
  activeTab?: number | null;
  darkMode?: boolean;
}

const pendingRequests = new Map<string, PendingRequest>();

// Setup WebSocket message handlers to route responses back to API requests
function setupMessageHandlers() {
  // Handler for search results
  ClientManager.onMessageType("search-results", (client: Client, data: any) => {
    log.info(`Received search results for requestId: ${data.requestId}`);
    
    if (data.requestId && pendingRequests.has(data.requestId)) {
      const pending = pendingRequests.get(data.requestId)!;
      
      if (pending.type === 'search' && pending.clientId) {
        
        // Send response with metadata
        safeResponse(pending.res, 200, {
          requestId: data.requestId,
          clientId: pending.clientId,
          query: data.query || pending.query || "",
          filter: data.filter || pending.filter,
          totalResults: data.results.length,
          results: data.results
        });
        
        // Remove pending request
        pendingRequests.delete(data.requestId);
        return;
      }
    }
  });
  
  // Handler for entity data
  ClientManager.onMessageType("entity-data", (client: Client, data: any) => {
    log.info(`Received entity data for requestId: ${data.requestId}, uuid: ${data.uuid}`);
    
    if (data.requestId && pendingRequests.has(data.requestId)) {
      const pending = pendingRequests.get(data.requestId)!;
      
      if (pending.type === 'entity' && data.data) {
        
        // Include metadata in response wrapper
        safeResponse(pending.res, 200, {
          requestId: data.requestId,
          clientId: pending.clientId,
          uuid: data.uuid,
          data: data.data
        });
        
        // Remove pending request
        pendingRequests.delete(data.requestId);
        return;
      }
    }
  });

  // Handler for structure data
  ClientManager.onMessageType("structure-data", (client: Client, data: any) => {
    log.info(`Received structure data for requestId: ${data.requestId}`);
    
    if (data.requestId && pendingRequests.has(data.requestId)) {
      const pending = pendingRequests.get(data.requestId)!;
      
      if (pending.type === 'structure') {
        // Send response with metadata
        safeResponse(pending.res, 200, {
          requestId: data.requestId,
          clientId: pending.clientId,
          folders: data.folders || [],
          compendiums: data.compendiums || []
        });
        
        // Remove pending request
        pendingRequests.delete(data.requestId);
        return;
      }
    }
  });

  // Handler for contents data
  ClientManager.onMessageType("contents-data", (client: Client, data: any) => {
    log.info(`Received contents data for requestId: ${data.requestId}, path: ${data.path}`);
    
    if (data.requestId && pendingRequests.has(data.requestId)) {
      const pending = pendingRequests.get(data.requestId)!;
      
      if (pending.type === 'contents' && pending.path === data.path) {
        // Send response with metadata
        safeResponse(pending.res, 200, {
          requestId: data.requestId,
          clientId: pending.clientId,
          path: data.path,
          entities: data.entities || []
        });
        
        // Remove pending request
        pendingRequests.delete(data.requestId);
        return;
      }
    }
  });

  // Handler for entity creation response
  ClientManager.onMessageType("entity-created", (client: Client, data: any) => {
    log.info(`Received entity created response for requestId: ${data.requestId}`);
    
    if (data.requestId && pendingRequests.has(data.requestId)) {
      const pending = pendingRequests.get(data.requestId)!;
      
      if (pending.type === 'create') {
        if (data.error) {
          safeResponse(pending.res, 400, {
            requestId: data.requestId,
            clientId: pending.clientId,
            error: data.error,
            message: data.message || "Failed to create entity"
          });
        } else {
          // Send response with the new entity data and metadata
          safeResponse(pending.res, 201, {
            requestId: data.requestId,
            clientId: pending.clientId,
            uuid: data.uuid,
            entity: data.entity
          });
        }
        
        // Remove pending request
        pendingRequests.delete(data.requestId);
        return;
      }
    }
  });

  // Handler for entity update response
  ClientManager.onMessageType("entity-updated", (client: Client, data: any) => {
    log.info(`Received entity updated response for requestId: ${data.requestId}`);
    
    if (data.requestId && pendingRequests.has(data.requestId)) {
      const pending = pendingRequests.get(data.requestId)!;
      
      if (pending.type === 'update' && pending.uuid === data.uuid) {
        if (data.error) {
          safeResponse(pending.res, 400, {
            requestId: data.requestId,
            clientId: pending.clientId,
            uuid: data.uuid,
            error: data.error,
            message: data.message || "Failed to update entity"
          });
        } else {
          // Send response with the updated entity data and metadata
          safeResponse(pending.res, 200, {
            requestId: data.requestId,
            clientId: pending.clientId,
            uuid: data.uuid,
            entity: data.entity
          });
        }
        
        // Remove pending request
        pendingRequests.delete(data.requestId);
        return;
      }
    }
  });

  // Handler for entity deletion response
  ClientManager.onMessageType("entity-deleted", (client: Client, data: any) => {
    log.info(`Received entity deleted response for requestId: ${data.requestId}`);
    
    if (data.requestId && pendingRequests.has(data.requestId)) {
      const pending = pendingRequests.get(data.requestId)!;
      
      if (pending.type === 'delete' && pending.uuid === data.uuid) {
        if (data.error) {
          safeResponse(pending.res, 400, {
            requestId: data.requestId,
            clientId: pending.clientId,
            uuid: data.uuid,
            error: data.error,
            message: data.message || "Failed to delete entity"
          });
        } else {
          // Send success response with metadata
          safeResponse(pending.res, 200, {
            requestId: data.requestId,
            clientId: pending.clientId,
            uuid: data.uuid,
            message: "Entity successfully deleted"
          });
        }
        
        // Remove pending request
        pendingRequests.delete(data.requestId);
        return;
      }
    }
  });

  // Handler for rolls data response
  ClientManager.onMessageType("rolls-data", (client: Client, data: any) => {
    log.info(`Received rolls data response for requestId: ${data.requestId}`);
    
    if (data.requestId && pendingRequests.has(data.requestId)) {
      const pending = pendingRequests.get(data.requestId)!;
      
      if (pending.type === 'rolls') {
        // Send response
        safeResponse(pending.res, 200, {
          clientId: client.getId(),
          rolls: data.data || []
        });
        
        // Remove pending request
        pendingRequests.delete(data.requestId);
      }
    }
  });

  // Handler for last roll data response
  ClientManager.onMessageType("last-roll-data", (client: Client, data: any) => {
    log.info(`Received last roll data response for requestId: ${data.requestId}`);
    
    if (data.requestId && pendingRequests.has(data.requestId)) {
      const pending = pendingRequests.get(data.requestId)!;
      
      if (pending.type === 'lastroll') {
        
        // Send response
        safeResponse(pending.res, 200, {
          clientId: client.getId(),
          roll: data.data || null
        });
        
        // Remove pending request
        pendingRequests.delete(data.requestId);
      }
    }
  });

  // Handler for roll result
  ClientManager.onMessageType("roll-result", (client: Client, data: any) => {
    log.info(`Received roll result for requestId: ${data.requestId}`);
    
    if (data.requestId && pendingRequests.has(data.requestId)) {
      const pending = pendingRequests.get(data.requestId)!;
      
      if (pending.type === 'roll') {
        if (!data.success) {
          safeResponse(pending.res, 400, {
            clientId: client.getId(),
            error: data.error || "Failed to perform roll"
          });
        } else {
          
          // Send response
          safeResponse(pending.res, 200, {
            clientId: client.getId(),
            success: true,
            roll: data.data
          });
        }
        
        // Remove pending request
        pendingRequests.delete(data.requestId);
      }
    }
  });

  // Handler for actor sheet HTML response
  ClientManager.onMessageType("actor-sheet-html-response", (client: Client, data: any) => {
    log.info(`Received actor sheet HTML response for requestId: ${data.requestId}`);
    
    try {
      // Extract the UUID from either data.uuid or data.data.uuid
      const responseUuid = data.uuid || (data.data && data.data.uuid);
      
      // Debug what we're receiving
      log.debug(`Actor sheet response data structure:`, {
        requestId: data.requestId,
        uuid: responseUuid,
        dataKeys: data.data ? Object.keys(data.data) : [],
        html: data.data && data.data.html ? `${data.data.html.substring(0, 100)}...` : undefined,
        cssLength: data.data && data.data.css ? data.data.css.length : 0
      });
      
      if (data.requestId && pendingRequests.has(data.requestId)) {
        const pending = pendingRequests.get(data.requestId)!;
        
        // Compare with either location
        if (pending.type === 'actor-sheet' && pending.uuid === responseUuid) {
          if (data.error || (data.data && data.data.error)) {
            const errorMsg = data.error || (data.data && data.data.error) || "Unknown error";
            safeResponse(pending.res, 404, {
              requestId: data.requestId,
              clientId: pending.clientId,
              uuid: pending.uuid,
              error: errorMsg
            });
          } else {
            // Get HTML content from either data or data.data
            let html = data.html || (data.data && data.data.html) || '';
            const css = data.css || (data.data && data.data.css) || '';
            
            // Get the system ID for use in the HTML output
            const gameSystemId = (client as any).metadata?.systemId || 'unknown';
            
            if (pending.format === 'json') {
              // Send response as JSON
              safeResponse(pending.res, 200, {
                requestId: data.requestId,
                clientId: pending.clientId,
                uuid: pending.uuid,
                html: html,
                css: css
              });
            } else {
              // Get the scale and tab parameters from the pending request
              const initialScale = pending.initialScale || null;
              // Convert activeTab to a number if it exists, or keep as null
              const activeTabIndex = pending.activeTab !== null ? Number(pending.activeTab) : null;

              // If a specific tab index is requested, pre-process the HTML to activate that tab
              if (activeTabIndex !== null && !isNaN(activeTabIndex)) {
              try {
                // Create a virtual DOM to manipulate the HTML
                const dom = new JSDOM(html);
                const document = dom.window.document;
                
                // Find all tab navigation elements
                const tabsElements = document.querySelectorAll('nav.tabs, .tabs');
                
                tabsElements.forEach(tabsElement => {
                // Find all tab items and content tabs
                const tabs = Array.from(tabsElement.querySelectorAll('.item'));
                const sheet = tabsElement.closest('.sheet');
                
                if (sheet && tabs.length > 0 && activeTabIndex < tabs.length) {
                  const tabContent = sheet.querySelectorAll('.tab');
                  
                  if (tabs.length > 0 && tabContent.length > 0) {
                  // Deactivate all tabs first
                  tabs.forEach(tab => tab.classList.remove('active'));
                  tabContent.forEach(content => content.classList.remove('active'));
                  
                  // Get the tab at the specified index
                  const targetTab = tabs[activeTabIndex];
                  
                  if (targetTab) {
                    // Get the data-tab attribute from this tab
                    const tabName = targetTab.getAttribute('data-tab');
                    
                    // Find the corresponding content tab
                    let targetContent = null;
                    for (let i = 0; i < tabContent.length; i++) {
                    if (tabContent[i].getAttribute('data-tab') === tabName) {
                      targetContent = tabContent[i];
                      break;
                    }
                    }
                    
                    // Activate both the tab and its content
                    targetTab.classList.add('active');
                    if (targetContent) {
                    targetContent.classList.add('active');
                    log.debug(`Pre-activated tab index ${activeTabIndex} with data-tab: ${tabName}`);
                    }
                  }
                  }
                }
                });
                
                // Get the modified HTML
                html = document.querySelector('body')?.innerHTML || html;
                }
              catch (error) {
                log.warn(`Failed to pre-process HTML for tab selection: ${error}`);
                // Continue with the original HTML if there was an error
              }}

              // If dark mode is requested, flag it for later use in the full HTML document
              const darkModeEnabled = pending.darkMode || false;

              // Determine if we should include interactive JavaScript
              const includeInteractiveJS = initialScale === null && activeTabIndex === null;

              // Create a complete HTML document with the CSS embedded
              const fullHtml = `
              <!DOCTYPE html>
              <html>
              <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='0.9em' font-size='90'>🎲</text></svg>">
                <title>Actor Sheet - ${responseUuid}</title>
                
                <!-- Include Font Awesome from CDN (both CSS and font files) -->
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" integrity="sha512-SnH5WK+bZxgPHs44uWIX+LLJAJ9/2PkPKZ5QiAj6Ta86w+fsb2TkcmfRyVX3pBnMFcV7oQPJkl9QevSCWr3W6A==" crossorigin="anonymous" referrerpolicy="no-referrer" />
                
                <style>
                /* Reset some browser defaults */
                * {
                box-sizing: border-box;
                }
                
                /* Base styles for the document */
                body {
                margin: 0;
                padding: 10px;
                background-color: rgba(0, 0, 0, 0.5);
                color: #191813;
                font-family: "Signika", sans-serif;
                }
                
                /* Center the sheet on the page */
                body {
                display: flex;
                justify-content: center !important;
                align-items: center;
                min-height: 100vh;
                }
                
                /* Responsive sheet container */
                .sheet-container {
                width: 100%;
                max-width: 100vw;
                height: auto;
                display: flex;
                justify-content: center;
                align-items: center;
                transform-origin: top center;
                }
                
                /* Foundry window styles to make sheet look natural */
                .app {
                border-radius: 5px;
                box-shadow: 0 0 20px #000;
                width: 100%;
                height: auto;
                max-width: 800px; /* Base size for standard screens */
                min-width: 320px;
                position: relative;
                transition: transform 0.2s ease;
                transform-origin: center;
                ${initialScale ? `transform: scale(${initialScale}) translate(${((1-initialScale)/(2*initialScale))*100}%, ${((1-initialScale)/(2*initialScale))*100}%);` : ''}
                }
                
                ${!initialScale ? `
                /* Responsive scaling for different screen sizes */
                @media (max-width: 900px) {
                .app {
                transform: scale(0.8) translate(12.5%, 12.5%);
                max-width: 95vw;
                }
                }
                
                @media (max-width: 768px) {
                .app {
                transform: scale(0.6) translate(33.33%, 33.33%);
                max-width: 95vw;
                }
                }
                
                @media (max-width: 576px) {
                .app {
                transform: scale(0.4) translate(75%, 75%);
                max-width: 100vw;
                }
                }` : ''}
                
                /* Ensure content within the app scales properly */
                .window-content {
                height: auto !important;
                overflow-y: auto;
                max-height: calc(100vh - 50px);
                }
                
                /* Include captured CSS from Foundry - with asset URLs fixed to use proxy 
                AND override Font Awesome font file references */
                ${css.replace(/url\(['"]?(.*?)['"]?\)/g, (match: string, url: string): string => {
                // Skip data URLs
                if (url.startsWith('data:')) return match;
                
                // Skip CDN URLs
                if (url.startsWith('http')) return match;
                
                // Skip fontawesome webfont references - we'll handle those separately
                if (url.includes('fa-') && (url.endsWith('.woff') || url.endsWith('.woff2') || url.endsWith('.ttf') || url.endsWith('.eot') || url.endsWith('.svg'))) {
                return match; // These will be overridden by our CDN
                }
                
                // Proxy all other assets
                if (url.startsWith('/')) return `url('/proxy-asset${url}?clientId=${pending.clientId}')`;
                return `url('/proxy-asset/${url}?clientId=${pending.clientId}')`;
                })}
                
                /* Fix any specific issues with the extracted sheet */
                img {
                max-width: 100%;
                height: auto;
                }
                
                /* Override any problematic styles */
                .window-app {
                position: relative !important;
                top: auto !important;
                left: auto !important;
                }
                
                /* Fix Font Awesome icons - override any local @font-face declarations */
                @font-face {
                font-family: 'Font Awesome 5 Free';
                font-style: normal;
                font-weight: 900;
                src: url("https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/webfonts/fa-solid-900.woff2") format("woff2"),
                   url("https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/webfonts/fa-solid-900.ttf") format("truetype");
                }
                
                @font-face {
                font-family: 'Font Awesome 5 Free';
                font-style: normal;
                font-weight: 400;
                src: url("https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/webfonts/fa-regular-400.woff2") format("woff2"),
                   url("https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/webfonts/fa-regular-400.ttf") format("truetype");
                }
                
                @font-face {
                font-family: 'Font Awesome 5 Brands';
                font-style: normal;
                font-weight: 400;
                src: url("https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/webfonts/fa-brands-400.woff2") format("woff2"),
                   url("https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/webfonts/fa-brands-400.ttf") format("truetype");
                }
                
                /* Additional support for Font Awesome 6 Pro (which Foundry might be using) */
                .fa, .fas, .fa-solid, .far, .fa-regular, .fal, .fa-light, .fat, .fa-thin, .fad, .fa-duotone, .fab, .fa-brands {
                font-family: 'Font Awesome 5 Free' !important;
                font-weight: 900 !important;
                }
                
                .far, .fa-regular {
                font-weight: 400 !important;
                }
                
                .fab, .fa-brands {
                font-family: 'Font Awesome 5 Brands' !important;
                font-weight: 400 !important;
                }
                
                /* Add web font definitions for common Foundry fonts */
                @font-face {
                font-family: 'Signika';
                src: url('/proxy-asset/fonts/signika/signika-regular.woff2?clientId=${pending.clientId}') format('woff2');
                font-weight: 400;
                font-style: normal;
                }
                
                @font-face {
                font-family: 'Modesto Condensed';
                src: url('/proxy-asset/fonts/modesto-condensed/modesto-condensed-bold.woff2?clientId=${pending.clientId}') format('woff2');
                font-weight: 700;
                font-style: normal;
                }
                
                /* Fix for badges */
                .ac-badge {
                background-image: url("https://raw.githubusercontent.com/foundryvtt/dnd5e/master/ui/ac-badge.webp") !important;
                }
                
                .cr-badge {
                background-image: url("https://raw.githubusercontent.com/foundryvtt/dnd5e/master/ui/cr-badge.webp") !important;
                }

                .dnd5e2.sheet.actor.npc .sheet-header .legendary .legact .pip.filled {
                background-image: url("https://raw.githubusercontent.com/foundryvtt/dnd5e/master/ui/legact-active.webp") !important;
                }

                .dnd5e2.sheet.actor.npc .sheet-header .legendary .legact .pip.empty {
                background-image: url("https://raw.githubusercontent.com/foundryvtt/dnd5e/master/ui/legact-inactive.webp") !important;
                }

                .dnd5e2.sheet.actor.npc .window-content::before, .dnd5e2.sheet.actor.npc.dnd5e-theme-dark .window-content::before {
                content: "";
                position: absolute;
                inset: 0 0 auto 0;
                height: 300px;
                border-radius: 5px 5px 0 0;
                opacity: 0.2;
                background: url("https://raw.githubusercontent.com/foundryvtt/dnd5e/master/ui/official/banner-npc-dark.webp") no-repeat top center / cover !important;
                -webkit-mask-image: linear-gradient(to bottom, black, transparent);
                mask-image: linear-gradient(to bottom, black, transparent);
                }

                .window-content {
                max-height: unset !important;
                }
                
                /* Zoom controls for manual scaling */
                .zoom-controls {
                position: fixed;
                bottom: 20px;
                right: 20px;
                display: flex;
                gap: 10px;
                z-index: 1000;
                }
                
                .zoom-controls button {
                width: 40px;
                height: 40px;
                border-radius: 50%;
                border: none;
                background: rgba(0, 0, 0, 0.7);
                color: white;
                font-size: 18px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 2px 5px rgba(0, 0, 0, 0.3);
                }
                
                .zoom-controls button:hover {
                background: rgba(0, 0, 0, 0.9);
                }
                </style>
              </head>
              <body class="vtt game system-${gameSystemId} ${darkModeEnabled ? ' theme-dark dnd5e-theme-dark' : ''}">
                <div class="sheet-container">
                ${html.replace(/src="([^"]+)"/g, (match: string, src: string) => {
                if (src.startsWith('data:')) return match;
                if (src.startsWith('http')) return match;
                if (src.startsWith('/')) return `src="/proxy-asset${src}?clientId=${pending.clientId}"`;
                return `src="/proxy-asset/${src}?clientId=${pending.clientId}"`;
                })}
                </div>
                
                ${includeInteractiveJS ? `
                <div class="zoom-controls">
                <button id="zoom-in" title="Zoom In">+</button>
                <button id="zoom-out" title="Zoom Out">-</button>
                <button id="zoom-reset" title="Reset Zoom">↺</button>
                </div>` : ''}
                
                <!-- Add a simple script to fix any remaining icons that might be added dynamically -->
                <script>
                document.addEventListener('DOMContentLoaded', function() {
                // Check if Font Awesome is loaded
                const cssLoaded = Array.from(document.styleSheets).some(sheet => 
                sheet.href && sheet.href.includes('font-awesome')
                );
                
                if (!cssLoaded) {
                console.warn('Font Awesome stylesheet not detected, adding fallback');
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
                document.head.appendChild(link);
                }
                
                // Fix common textures that might be loaded dynamically
                const addImageFallback = (selector, fallbackUrl) => {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => {
                  if (window.getComputedStyle(el).backgroundImage === 'none' || 
                  window.getComputedStyle(el).backgroundImage.includes('texture')) {
                  el.style.backgroundImage = 'url(' + fallbackUrl + ')';
                  }
                });
                };
                
                // Apply fallbacks for commonly used textures
                addImageFallback('.window-content', 'https://raw.githubusercontent.com/foundryvtt/dnd5e/master/ui/parchment.jpg');
                addImageFallback('.ac-badge', 'https://raw.githubusercontent.com/foundryvtt/dnd5e/master/ui/ac-badge.svg');
                addImageFallback('.cr-badge', 'https://raw.githubusercontent.com/foundryvtt/dnd5e/master/ui/cr-badge.svg');
                
                ${includeInteractiveJS ? `
                // Implement sheet scaling functionality
                let currentScale = 1;
                const app = document.querySelector('.app');
                const zoomIn = document.getElementById('zoom-in');
                const zoomOut = document.getElementById('zoom-out');
                const zoomReset = document.getElementById('zoom-reset');
                
                function updateScale() {
                  if (app) {
                  // Calculate translation percentage based on scale
                  // Formula: translate = ((1-scale) / (2*scale)) * 100%
                  const translatePct = ((1 - currentScale) / (2 * currentScale)) * 100;
                  app.style.transform = \`scale(\${currentScale}) translate(\${translatePct}%, \${translatePct}%)\`;
                  }
                }
                
                if (zoomIn) {
                zoomIn.addEventListener('click', () => {
                  if (currentScale < 1.5) {
                  currentScale += 0.1;
                  updateScale();
                  }
                });
                }
                
                if (zoomOut) {
                zoomOut.addEventListener('click', () => {
                  if (currentScale > 0.5) {
                  currentScale -= 0.1;
                  updateScale();
                  }
                });
                }
                
                if (zoomReset) {
                zoomReset.addEventListener('click', () => {
                  currentScale = 1;
                  updateScale();
                });
                }
                
                // Implement responsive behavior for window resizing
                function handleResize() {
                const viewportWidth = window.innerWidth;
                const viewportHeight = window.innerHeight;
                
                // Reset scale when resizing to get proper measurements
                app.style.transform = 'scale(1)';
                
                // Get actual dimensions
                const sheetWidth = app.offsetWidth;
                const sheetHeight = app.offsetHeight;
                
                // Calculate max scale that would fit in viewport
                const maxScaleWidth = (viewportWidth * 0.95) / sheetWidth;
                const maxScaleHeight = (viewportHeight * 0.95) / sheetHeight;
                
                // Use the smaller of the two scales to ensure full visibility
                const optimalScale = Math.min(maxScaleWidth, maxScaleHeight, 1);
                
                // Apply only if significantly different than current scale
                if (Math.abs(currentScale - optimalScale) > 0.05) {
                  currentScale = optimalScale;
                  updateScale();
                }
                }
                
                // Initial sizing and resize event
                window.addEventListener('resize', handleResize);
                handleResize();` : ''}
                });
                ${includeInteractiveJS ? `</script>

                <!-- Tab functionality -->
                <script>
                // Tab functionality
                function activateActorSheetTab(tabsElement, tabName) {
                // Get all tab items and tab content elements
                const tabs = tabsElement.querySelectorAll('.item');
                const contents = tabsElement.closest('.sheet').querySelectorAll('.tab');
                
                // Hide all tab content and deactivate tab items
                tabs.forEach(t => t.classList.remove('active'));
                contents.forEach(c => c.classList.remove('active'));
                
                // Find the tab item with matching data-tab and activate it
                const activeTab = tabsElement.querySelector(\`.item[data-tab="\${tabName}"]\`);
                if (activeTab) activeTab.classList.add('active');
                
                // Find the tab content with matching data-tab and activate it
                const activeContent = tabsElement.closest('.sheet').querySelector(\`.tab[data-tab="\${tabName}"]\`);
                if (activeContent) activeContent.classList.add('active');
                }

                // Set up tab click handlers
                document.addEventListener('DOMContentLoaded', function() {
                // Find all tabs in the sheet
                const tabsElements = document.querySelectorAll('nav.tabs, .tabs');
                
                ${activeTabIndex ? `
                // Activate the specified tab
                tabsElements.forEach(tabsElement => {
                  activateActorSheetTab(tabsElement, "${activeTabIndex}");
                });` : `
                // Set up click handlers for tabs and activate first tabs
                tabsElements.forEach(tabsElement => {
                  // Add click event listeners to each tab
                  const tabItems = tabsElement.querySelectorAll('.item');
                  
                  tabItems.forEach(tab => {
                    tab.addEventListener('click', function(event) {
                    event.preventDefault();
                    const tabName = this.dataset.tab;
                    if (tabName) {
                      activateActorSheetTab(tabsElement, tabName);
                    }
                    });
                  });
                  
                  // Activate the first tab by default if none is active
                  if (!tabsElement.querySelector('.item.active')) {
                    const firstTab = tabsElement.querySelector('.item');
                    if (firstTab) {
                      const tabName = firstTab.dataset.tab;
                      if (tabName) {
                        activateActorSheetTab(tabsElement, tabName);
                      }
                    }
                  }
                });`}
                });
                </script>` : ''}
              </body>
              </html>`;
              
              pending.res.send(fullHtml);
            }
          }
          
          // Remove pending request
          pendingRequests.delete(data.requestId);
        } else {
          // Log an issue if UUID doesn't match what we expect
          log.warn(`Received actor sheet response with mismatched values: expected type=${pending.type}, uuid=${pending.uuid}, got uuid=${responseUuid}`);
        }
      } else {
        log.warn(`Received actor sheet response for unknown requestId: ${data.requestId}`);
      }
    } catch (error) {
      log.error(`Error handling actor sheet HTML response:`, { error });
      log.debug(`Response data that caused the error:`, {
        requestId: data.requestId,
        hasData: !!data.data,
        dataType: typeof data.data
      });
    }
  });

  // Clean up old pending requests periodically
  setInterval(() => {
    const now = Date.now();
    for (const [requestId, request] of pendingRequests.entries()) {
      // Remove requests older than 30 seconds
      if (now - request.timestamp > 30000) {
        log.warn(`Request ${requestId} timed out and was never completed`);
        pendingRequests.delete(requestId);
      }
    }
  }, 10000);
}
