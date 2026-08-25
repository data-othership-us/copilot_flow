import axios from "axios";
import dotenv from "dotenv";
import { findCopilotUserByName } from "../mt/copilotUserLookup.js";
import { copilotDbRef, getBigQueryClient } from "../bqConfig.js";

dotenv.config();

//-------------------------------- Config --------------------------------
const bigquery = getBigQueryClient();
const MT_API_BASE_URL_RAW = (process.env.MT_API_BASE_URL || "").replace(/\/+$/, "");
const MT_API_BASE_URL = MT_API_BASE_URL_RAW.endsWith("/api")
  ? MT_API_BASE_URL_RAW
  : `${MT_API_BASE_URL_RAW}/api`;
const MT_API_KEY = process.env.MT_API_KEY;
const COPILOT_DB = copilotDbRef();

//-------------------------------- Query BigQuery for all rows without user_id --------------------------------
async function getAllRowsWithoutUserID() {
  console.log(`📊 Querying BigQuery for all rows without user_id from ${COPILOT_DB}...`);
  
  try {
    // Get all rows that don't have a user_id
    const query = `SELECT contact_email, first_name, last_name FROM ${COPILOT_DB} 
      WHERE (user_id IS NULL OR user_id = '') 
      AND contact_email IS NOT NULL 
      AND contact_email != ''`;
    const [rows] = await bigquery.query({ query });
    
    console.log(`✅ Found ${rows.length} rows without user_id to process`);
    return rows;
  } catch (error) {
    console.error(`❌ Error querying BigQuery:`, error.message);
    throw error;
  }
}

//-------------------------------- Call API to find user by email --------------------------------
async function findUserByEmail(email) {
  try {
    const response = await axios.get(`${MT_API_BASE_URL}/users`, {
      headers: { Authorization: `Bearer ${MT_API_KEY}` },
      params: {
        email: email,
      },
    });
    
    // The API might return an array or a single object
    const data = response.data?.data;
    if (Array.isArray(data)) {
      return data.length > 0 ? data[0] : null; // Return the first user found or null if empty
    } else if (data && typeof data === 'object') {
      return data;
    }
    
    return null;
  } catch (error) {
    if (error.response?.status === 404) {
      return null;
    }
    console.error(`❌ Error finding user by email ${email}:`, error.message);
    return null;
  }
}

//-------------------------------- Name lookup: prefer users with Co-Pilot membership (not employees) --------------------------------
async function findUserByName(firstName, lastName) {
  return findCopilotUserByName(MT_API_BASE_URL, MT_API_KEY, firstName, lastName);
}

//-------------------------------- Update single row in BigQuery --------------------------------
async function updateRowInBigQuery(update) {
  if (!update.user_id) return false; // Skip if no user_id found
  
  try {
    // Escape single quotes
    const escapedEmail = update.contact_email.replace(/'/g, "''");
    const escapedUserID = String(update.user_id).replace(/'/g, "''");
    const escapedMtEmail = update.mt_email ? update.mt_email.replace(/'/g, "''") : null;
    const mtProfileLink = `https://othership.marianatek.com/admin/user/profile/${escapedUserID}`;
    const escapedMtProfileLink = mtProfileLink.replace(/'/g, "''"); // Escape quotes in URL
    
    // Build SET clause - always update user_id, mt_email, and mt_profile_link if provided
    let setClause = `user_id = '${escapedUserID}'`;
    if (escapedMtEmail) {
      setClause += `, mt_email = '${escapedMtEmail}'`;
    }
    // Always set mt_profile_link when user_id is found
    setClause += `, mt_profile_link = '${escapedMtProfileLink}'`;
    
    // Update rows with this contact_email that don't have a user_id
    const updateQuery = `
      UPDATE ${COPILOT_DB}
      SET ${setClause}
      WHERE contact_email = '${escapedEmail}'
      AND (user_id IS NULL OR user_id = '')
    `;
    
    await bigquery.query({ query: updateQuery });
    return true;
  } catch (error) {
    console.error(`❌ Error updating row for ${update.contact_email}:`, error.message);
    return false;
  }
}

//-------------------------------- Update BigQuery with user_id, mt_email, and mt_profile_link (batch) --------------------------------
async function updateUserIDsInBigQuery(updates) {
  if (updates.length === 0) return 0;
  
  try {
    let totalUpdated = 0;
    
    // Updates is an array of {contact_email, user_id, mt_email}
    for (const update of updates) {
      const success = await updateRowInBigQuery(update);
      if (success) totalUpdated++;
    }
    
    return totalUpdated;
  } catch (error) {
    console.error(`❌ Error updating BigQuery:`, error.message);
    throw error;
  }
}

//-------------------------------- Main Function --------------------------------
async function findUserIDs() {
  console.log("🚀 Starting user_id lookup and update process...");
  
  try {
    // Get all rows from BigQuery without user_id
    const rows = await getAllRowsWithoutUserID();
    
    if (rows.length === 0) {
      console.log("⚠️ No rows found in the table without user_id");
      return [];
    }
    
    // Process each row and update in batches (fetch async, insert sequential)
    const BATCH_SIZE = 10; // Update BigQuery every 10 rows
    const results = [];
    let totalUpdated = 0;
    let batchUpdates = [];
    const batchQueue = []; // Queue for batches waiting to be inserted
    let processingComplete = false; // Flag to indicate when all rows are processed
    
    // Function to process the batch queue sequentially
    async function processBatchQueue() {
      while (!processingComplete || batchQueue.length > 0) {
        if (batchQueue.length === 0) {
          // Wait a bit if queue is empty but processing might still be happening
          await new Promise(resolve => setTimeout(resolve, 200));
          continue;
        }
        
        // Process next batch in queue (sequential - one at a time)
        const batchToUpdate = batchQueue.shift();
        
        console.log(`💾 Updating batch of ${batchToUpdate.length} rows...`);
        
        try {
          const batchUpdated = await updateUserIDsInBigQuery(batchToUpdate);
          totalUpdated += batchUpdated;
          console.log(`✅ Batch completed: ${batchUpdated} rows updated (Total: ${totalUpdated} so far)`);
        } catch (error) {
          console.error(`❌ Batch update failed:`, error.message);
        }
      }
    }
    
    // Start the queue processor in the background
    const queueProcessor = processBatchQueue();
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const contactEmail = row.contact_email;
      const firstName = row.first_name;
      const lastName = row.last_name;
      
      let user = null;
      let foundBy = '';
      
      // Step 1: Try to find by email first
      console.log(`🔍 [${i + 1}/${rows.length}] Looking up user by email: ${contactEmail}`);
      user = await findUserByEmail(contactEmail);
      
      if (user) {
        foundBy = 'email';
        const userId = user.id;
        console.log(`   ✅ Found user_id ${userId} by email`);
      } else {
        // Step 2: If not found by email, try by first_name and last_name
        if (firstName && lastName) {
          console.log(
            `   🔍 Trying name lookup (Co-Pilot membership required): ${firstName} ${lastName}`
          );
          user = await findUserByName(firstName, lastName);
          
          if (user) {
            foundBy = 'name';
            const userId = user.id;
            console.log(`   ✅ Found user_id ${userId} by name + Co-Pilot membership`);
          }
        }
      }
      
      // Step 3: If user found, extract id and attributes.email
      let user_id = null;
      let mt_email = null;
      
      if (user) {
        // Extract user_id and email from attributes
        user_id = user.id || null;
        mt_email = user.attributes?.email || null;
        
        // Prepare update object
        const update = {
          contact_email: contactEmail,
          user_id: user_id,
          mt_email: mt_email,
        };
        
        batchUpdates.push(update);
      }
      
      results.push({
        contact_email: contactEmail,
        first_name: firstName,
        last_name: lastName,
        user_id: user_id,
        mt_email: mt_email,
        found_by: foundBy || (user ? 'unknown' : null),
      });
      
      // When batch is ready, queue it for sequential insertion (don't wait)
      if (batchUpdates.length >= BATCH_SIZE || i === rows.length - 1) {
        if (batchUpdates.length > 0) {
          const batchToUpdate = [...batchUpdates]; // Copy the batch
          batchUpdates = []; // Clear the batch immediately
          batchQueue.push(batchToUpdate); // Add to queue
          console.log(`📦 Batch queued: ${batchToUpdate.length} rows (Queue size: ${batchQueue.length})`);
        }
      }
      
      // Add a small delay to avoid rate limiting
      if (i < rows.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Mark processing as complete and wait for all queued batches
    processingComplete = true;
    console.log(`\n⏳ Waiting for ${batchQueue.length} queued batches to complete...`);
    await queueProcessor;
    console.log(`✅ All batch updates completed`);
    
    // Summary
    const found = results.filter(r => r.user_id !== null);
    const notFound = results.filter(r => r.user_id === null);
    
    console.log(`\n✅ Process completed:`);
    console.log(`   📧 Total rows processed: ${rows.length}`);
    console.log(`   ✅ User IDs found: ${found.length}`);
    console.log(`   💾 Total rows updated in BigQuery: ${totalUpdated}`);
    console.log(`   ❌ User IDs not found: ${notFound.length}`);
    
    // Display list of rows without user_ids
    if (notFound.length > 0) {
      console.log(`\n📋 Rows without user_id found:`);
      notFound.forEach((result, index) => {
        const identifier = result.contact_email || `${result.first_name} ${result.last_name}`;
        console.log(`   ${index + 1}. ${identifier}`);
      });
      
      // Also save to a file
      const fs = await import('fs');
      const notFoundList = notFound.map(r => {
        return r.contact_email || `${r.first_name} ${r.last_name}`;
      }).join('\n');
      fs.writeFileSync('emails_not_found.txt', notFoundList);
      console.log(`\n💾 Saved ${notFound.length} entries to: emails_not_found.txt`);
    }
    
    return results;
  } catch (error) {
    console.error(`❌ Error in findUserIDs:`, error.message);
    throw error;
  }
}

// If run directly, execute the function
if (import.meta.url === `file://${process.argv[1]}`) {
  findUserIDs()
    .then(results => {
      console.log("\n📋 Results:", results);
    })
    .catch(error => {
      console.error("Failed:", error);
      process.exit(1);
    });
}
