// Add reconnection configuration
const RECONNECT_DELAY_MS = 3000; // Initial delay of 3 seconds
const MAX_RECONNECT_DELAY_MS = 30000; // Maximum delay of 30 seconds
let reconnectAttempts = 0;
let ws = null;

// Add after the posts object declaration
const RATE_CALCULATION_WINDOW = 30000; // 30 seconds in milliseconds
const POST_AGE_LIMIT = 60000; // 1 minute in milliseconds
const MIN_LIKES_PER_SECOND = 0.2;
const FIRE_THRESHOLD_HIGH = 1.0;  // Threshold to become "on fire"
const FIRE_THRESHOLD_LOW = 0.8;   // Threshold to lose "on fire" status

// Add these variables near the top with other constants
let startTime = Date.now();
let hasPostWith10Likes = false;
let processedPosts = 0;
let totalLikes = 0;

// Add this with the other constants at the top of the file
const INCLUDE_REPLIES = false;

// Add this constant with the other constants at the top
const MAX_POST_AGE = 1200000; // 20 minutes in milliseconds

// Add this near the top with other constants
const secondaryPosts = new Map(); // For tracking posts with <10 likes that were removed

// Add this with other constants at the top
const urlParams = new URLSearchParams(window.location.search);
const FOLLOWER_LIMIT = parseInt(urlParams.get('followerLimit')) || 0; // 0 means no limit

function connect() {
    const url = "wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post&wantedCollections=app.bsky.feed.like";
    
    ws = new WebSocket(url);

    ws.onopen = () => {
        console.log("Connected to Bluesky WebSocket");
        // Reset reconnection attempts on successful connection
        reconnectAttempts = 0;
    };

    ws.onmessage = (event) => {
        const json = JSON.parse(event.data);

        if (json.kind !== 'commit') return;

        if (json.commit.collection === 'app.bsky.feed.post') {
            if (!json.commit.record) return;

            if (json.commit.operation === 'create') {
                // Skip replies if INCLUDE_REPLIES is false
                if (!INCLUDE_REPLIES && json.commit.record.reply) return;

                processedPosts++;
                posts[json.commit.cid] = {
                    message: json.commit.record.text,
                    facets: json.commit.record.facets,
                    likes: 0,
                    likeHistory: [], // Add this line to track like timestamps
                    did: json.did,
                    url: `https://bsky.app/profile/${json.did}/post/${json.commit.rkey}`,
                    parentUrl: json.commit.record.reply ? 
                        `https://bsky.app/profile/${json.commit.record.reply.parent.uri.split('//')[1].split('/')[0]}/post/${json.commit.record.reply.parent.uri.split('/').pop()}` : 
                        null,
                    profile: null,
                    images: getImageUrls(json.commit.record, json.did),
                    createdAt: json.commit.record.createdAt,
                    timestamp: Date.now(),
                    firstLikeTimestamp: null,
                    rawJson: json,
                    embed: getExternalEmbed(json.commit.record, json.did) || 
                           getRecordEmbed(json.commit.record) ||
                           getVideoEmbed(json.commit.record, json.did),
                };
                updateTrackingDuration(); // Update the display immediately when a new post arrives
            }
        }

        if (json.commit.collection === 'app.bsky.feed.like') {
            if (!json.commit.record) return;

            if (json.commit.operation === 'create') {
                // Increment total likes for ALL likes
                totalLikes++;
                updateTrackingDuration();

                const cid = json.commit.record.subject.cid;
                
                // Check main posts first
                if (cid in posts) {
                    const post = posts[cid];
                    if (post.likes === 0) {
                        post.firstLikeTimestamp = Date.now();
                    }
                    post.likes++;
                    if (post.likes === 10 && !hasPostWith10Likes) {
                        hasPostWith10Likes = true;
                        setInterval(updateTrackingDuration, 1000);
                    }
                    post.likeHistory.push(Date.now());
                    updateTopPostsList();
                } 
                // Check secondary posts
                else if (secondaryPosts.has(cid)) {
                    const post = secondaryPosts.get(cid);
                    post.likes++;
                    post.likeHistory.push(Date.now());
                    
                    // If post reaches 10 likes, move it back to main posts
                    if (post.likes >= 10) {
                        // const timeSinceRemoved = Date.now() - post.removedAt;
                        // console.log(`Post ${cid} reached 10 likes - moving back to main posts. Time since removed: ${timeSinceRemoved} ms`);
                        // Reset timestamp to now to give it a fresh start
                        post.timestamp = Date.now();
                        posts[cid] = post;
                        secondaryPosts.delete(cid);
                        updateTopPostsList();
                    }
                }
            }
        }
    };

    ws.onerror = (error) => {
        console.error("WebSocket error:", error);
    };

    ws.onclose = (event) => {
        console.log(`WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason}`);
        
        // Calculate exponential backoff delay
        const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY_MS);
        reconnectAttempts++;
        
        console.log(`Attempting to reconnect in ${delay/1000} seconds...`);
        setTimeout(connect, delay);
    };
}

// Start initial connection
connect();

const posts = {};

function formatMessage(text, facets) {
    if (!facets) return text.replace(/\n/g, '<br>');
    
    // Sort facets by byteStart in descending order to process from end to start
    const sortedFacets = [...facets].sort((a, b) => b.index.byteStart - a.index.byteStart);
    
    let formattedText = text;
    
    // Process each facet
    for (const facet of sortedFacets) {
        const start = facet.index.byteStart;
        const end = facet.index.byteEnd;
        const originalText = text.slice(start, end);
        
        // Get the feature (assuming single feature per facet)
        const feature = facet.features[0];
        
        let replacement = originalText;
        if (feature.$type === 'app.bsky.richtext.facet#link') {
            replacement = `<a href="${feature.uri}" target="_blank">${originalText}</a>`;
        } else if (feature.$type === 'app.bsky.richtext.facet#tag') {
            replacement = `<span class="hashtag">#${feature.tag}</span>`;
        }
        
        formattedText = formattedText.slice(0, start) + replacement + formattedText.slice(end);
    }
    
    return formattedText.replace(/\n/g, '<br>');
}

async function fetchProfile(did) {
    try {
        const response = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${did}`);
        if (!response.ok) throw new Error('Failed to fetch profile');
        return await response.json();
    } catch (error) {
        console.error('Error fetching profile:', error);
        return null;
    }
}

// Add this function to handle image embeds
function getImageUrls(record, did) {
    if (!record.embed || record.embed.$type !== 'app.bsky.embed.images') {
        return null;
    }
    
    return record.embed.images.map(image => ({
        url: `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/${image.image.ref.$link}@jpeg`,
        alt: image.alt || ''
    }));
}

// Add this function to handle external embeds
function getExternalEmbed(record, did) {
    if (!record.embed || record.embed.$type !== 'app.bsky.embed.external') {
        return null;
    }
    
    const external = record.embed.external;
    return {
        title: external.title,
        description: external.description,
        uri: external.uri,
        thumb: external.thumb ? 
            `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/${external.thumb.ref.$link}@jpeg` : 
            null
    };
}

// Add this function to calculate recent likes per second
function calculateRecentLikesPerSecond(post) {
    const now = Date.now();
    const recentLikes = post.likeHistory.filter(timestamp => 
        now - timestamp <= RATE_CALCULATION_WINDOW
    ).length;
    
    // Calculate rate based on either the full window or time since first like
    const timeWindow = Math.min(
        RATE_CALCULATION_WINDOW,
        now - post.timestamp
    ) / 1000; // Convert to seconds
    
    return recentLikes / timeWindow;
}

// Modify the cleanupOldPosts function
function cleanupOldPosts() {
    const now = Date.now();
    
    // Clean up main posts
    Object.entries(posts).forEach(([cid, post]) => {
        const postAge = now - post.timestamp;
        
        // Always remove posts older than MAX_POST_AGE
        if (postAge > MAX_POST_AGE) {
            delete posts[cid];
            return;
        }
        
        // Handle cleanup for posts based on likes
        const likesPerSecond = calculateRecentLikesPerSecond(post);
        if (postAge > POST_AGE_LIMIT && likesPerSecond < MIN_LIKES_PER_SECOND) {
            if (post.likes >= 10) {
                // Remove posts with 10+ likes as before
                // Log info about posts that got a second chance
                if (post.removedAt) {
                    const timeInSecondary = now - post.removedAt;
                    if (post.likes > 30) {
                        // See how often posts with 30+ likes make it back to the main list
                        console.log(`Post ${cid} had a second chance - Time in secondary: ${timeInSecondary} ms, Final likes: ${post.likes}`);
                    }
                }
                delete posts[cid];
            } else {
                // Move posts with <10 likes to secondary map
                secondaryPosts.set(cid, {
                    ...post,
                    removedAt: now
                });
                delete posts[cid];
            }
        }
    });
    
    // Clean up secondary posts
    for (const [cid, post] of secondaryPosts) {
        const postAge = now - post.timestamp;
        if (postAge > MAX_POST_AGE) {
            secondaryPosts.delete(cid);
        }
    }
}

// Modify the updateTopPostsList function to call cleanup before updating
function updateTopPostsList() {
    // Add this line at the start of the function
    cleanupOldPosts();
    
    const topPostsDiv = document.getElementById('top-posts');
    const postsArray = Object.entries(posts)
        .filter(([_, post]) => post.likes > 0)
        .sort((a, b) => {
            // First sort by likes
            const likeDiff = b[1].likes - a[1].likes;
            if (likeDiff !== 0) return likeDiff;
            // If likes are equal, sort by earliest first like
            return a[1].firstLikeTimestamp - b[1].firstLikeTimestamp;
        })
        .slice(0, 20);
    
    // Check for posts that need profile fetching
    postsArray.forEach(([cid, post], index) => {
        if (!post.profile && (index === 0 || post.likes >= 10)) { // Always fetch for index 0
            // Fetch profile if not already fetching
            if (!post.fetchingProfile) {
                post.fetchingProfile = true;
                fetchProfile(post.did).then(profile => {
                    post.profile = profile;
                    post.fetchingProfile = false;
                    
                    // Remove post if user exceeds follower limit (when limit is enabled)
                    if (FOLLOWER_LIMIT > 0 && profile && profile.followersCount > FOLLOWER_LIMIT) {
                        delete posts[cid];
                        updateTopPostsList(); // Refresh the list
                        return;
                    }
                    
                    updateTopPostsList();
                });
            }
        }
    });

    // Rest of the updateTopPostsList function remains the same...
    const existingPosts = new Map();
    topPostsDiv.querySelectorAll('.post-item').forEach(element => {
        const cid = element.dataset.cid;
        existingPosts.set(cid, element);
    });
    
    postsArray.forEach(([cid, post], index) => {
        const existingElement = existingPosts.get(cid);
        
        if (existingElement) {
            // Update existing post
            const likesSpan = existingElement.querySelector('.likes');
            const likesPerSecond = calculateRecentLikesPerSecond(post);
            const isCurrentlyOnFire = likesSpan.classList.contains('on-fire');
            
            // Apply hysteresis and minimum likes requirement
            const shouldBeOnFire = post.likes >= 10 && (isCurrentlyOnFire 
                ? likesPerSecond >= FIRE_THRESHOLD_LOW    // Keep fire if above low threshold
                : likesPerSecond >= FIRE_THRESHOLD_HIGH); // Need to exceed high threshold to gain fire
            
            const likesInfo = `${shouldBeOnFire ? '🔥' : '❤️'} ${post.likes}`;
            if (likesSpan.textContent !== likesInfo) {
                likesSpan.textContent = likesInfo;
                likesSpan.classList.toggle('on-fire', shouldBeOnFire);
            }
            
            // Add rate update
            const rateSpan = existingElement.querySelector('.rate');
            rateSpan.textContent = `${likesPerSecond.toFixed(2)} ❤️/s`;
            
            // Update profile info if it was just fetched
            if (post.profile && existingElement.querySelector('.display-name').textContent === '🦋') {
                const profileInfo = existingElement.querySelector('.profile-info');
                profileInfo.innerHTML = `
                    <img src="${post.profile.avatar}" class="avatar" alt="Profile picture">
                    <div class="profile-details">
                        <div class="name-handle">
                            <div class="display-name">${post.profile.displayName}</div>
                            <div class="handle">@${post.profile.handle}</div>
                        </div>
                        <div class="compact-stats">
                            <span>${post.profile.followersCount.toLocaleString()} 👥</span>
                            <span>${post.profile.postsCount.toLocaleString()} 📝</span>
                        </div>
                    </div>
                `;
            }
            
            // Move the element to the correct position if needed
            if (existingElement.parentElement.children[index] !== existingElement) {
                topPostsDiv.insertBefore(existingElement, topPostsDiv.children[index]);
            }
            
            existingPosts.delete(cid);
        } else {
            // Create new post element
            const newElement = document.createElement('div');
            newElement.className = 'post-item';
            newElement.dataset.cid = cid;
            
            // Create the images section HTML if there are images
            const imagesHtml = post.images ? `
                <div class="post-images">
                    <button class="show-images-btn" onclick="toggleImages(this)">
                        Show ${post.images.length} image${post.images.length > 1 ? 's' : ''}
                    </button>
                    <div class="images-container" style="display: none;">
                        ${post.images.map(img => `
                            <img src="${img.url}" alt="${img.alt}" loading="lazy">
                        `).join('')}
                    </div>
                </div>
            ` : '';

            const embedHtml = post.embed ? 
                post.embed.type === 'record' ? `
                    <div class="post-embed">
                        <a href="${post.embed.url}" target="_blank" class="quoted-post-link">
                            View quoted post ↗
                        </a>
                    </div>
                ` : post.embed.type === 'video' ? `
                    <div class="post-embed video-embed">
                        <div class="video-indicator">
                            <span class="video-icon">🎥</span>
                            Video content
                            <a href="${post.url}" target="_blank" class="view-video-link">
                                View on Bluesky ↗
                            </a>
                        </div>
                    </div>
                ` : `
                    <div class="post-embed">
                        <button class="show-embed-btn" onclick="toggleEmbed(this)">
                            Show external content
                        </button>
                        <div class="embed-container" style="display: none;">
                            <a href="${post.embed.uri}" target="_blank" class="embed-link">
                                ${post.embed.thumb ? `<img src="${post.embed.thumb}" alt="Embed thumbnail" loading="lazy">` : ''}
                                <div class="embed-content">
                                    <h3 class="embed-title">${post.embed.title}</h3>
                                    <p class="embed-description">${post.embed.description}</p>
                                    <span class="embed-url">${new URL(post.embed.uri).hostname}</span>
                                </div>
                            </a>
                        </div>
                    </div>
                ` : '';

            newElement.innerHTML = `
                <div class="profile-info">
                    ${post.profile ? 
                        `<img src="${post.profile.avatar}" class="avatar" alt="Profile picture">` : 
                        '<div class="avatar-placeholder"></div>'
                    }
                    <div class="profile-details">
                        <div class="name-handle">
                            <div class="display-name">${post.profile ? post.profile.displayName : '🦋'}</div>
                            <div class="handle">${post.profile ? `@${post.profile.handle}` : `@${post.did.slice(0, 8)}...`}</div>
                        </div>
                        ${post.profile ? `
                            <div class="compact-stats">
                                <span>${post.profile.followersCount.toLocaleString()} 👥</span>
                                <span>${post.profile.postsCount.toLocaleString()} 📝</span>
                            </div>
                        ` : ''}
                    </div>
                </div>
                <div class="post-content">
                    ${formatMessage(post.message, post.facets)}
                    ${imagesHtml}
                    ${embedHtml}
                </div>
                <div class="post-meta">
                    <div class="meta-group likes-group">
                        <div class="likes ${(post.likes >= 10 && calculateRecentLikesPerSecond(post) >= FIRE_THRESHOLD_HIGH) ? 'on-fire' : ''}">
                            ${(post.likes >= 10 && calculateRecentLikesPerSecond(post) >= FIRE_THRESHOLD_HIGH) ? '🔥' : '❤️'} ${post.likes}
                        </div>
                    </div>
                    <div class="meta-group stats-group">
                        <span class="rate">${(calculateRecentLikesPerSecond(post)).toFixed(2)} ❤️/s</span>
                        <a href="${post.url}" target="_blank" class="view-link">View on Bluesky</a>
                        <button class="show-json-btn" onclick="toggleJson(this)" title="Show raw data">🛠️</button>
                        <span class="timestamp">${new Date(post.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                </div>
                <div class="json-container" style="display: none;">
                    <pre>${JSON.stringify(post.rawJson, null, 2)}</pre>
                </div>
            `;
            
            if (topPostsDiv.children[index]) {
                topPostsDiv.insertBefore(newElement, topPostsDiv.children[index]);
            } else {
                topPostsDiv.appendChild(newElement);
            }
        }
    });
    
    existingPosts.forEach(element => element.remove());
}
// Add this function to handle image toggling
function toggleImages(button) {
    const container = button.nextElementSibling;
    const isHidden = container.style.display === 'none';
    container.style.display = isHidden ? 'grid' : 'none';
    button.textContent = isHidden ? 'Hide images' : `Show ${container.children.length} image${container.children.length > 1 ? 's' : ''}`;
}

// Add this function to handle external embed toggling
function toggleEmbed(button) {
    const container = button.nextElementSibling;
    const isHidden = container.style.display === 'none';
    container.style.display = isHidden ? 'block' : 'none';
    button.textContent = isHidden ? 'Hide external content' : 'Show external content';
}

// Modify updateTrackingDuration
function updateTrackingDuration() {
    const trackingText = document.getElementById('tracking-text');
    const postCounter = document.getElementById('post-counter');
    const likesCounter = document.getElementById('likes-counter');
    const loadingProgress = document.querySelector('.loading-progress');
    
    // Update counters with separated numbers and emojis
    postCounter.innerHTML = processedPosts.toLocaleString();
    likesCounter.innerHTML = totalLikes.toLocaleString();
    
    // Update tracking text and loading bar state
    if (!hasPostWith10Likes) {
        trackingText.textContent = "Listening for new posts... Please wait.";
        loadingProgress.classList.remove('tracking');
        return;
    }
    
    const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);
    let timeText;
    if (elapsedMinutes < 1) {
        timeText = "<1 minute";
    } else if (elapsedMinutes === 1) {
        timeText = "1 minute";
    } else {
        timeText = `${elapsedMinutes} minutes`;
    }
    
    trackingText.textContent = `Tracking for ${timeText}.`;
    loadingProgress.classList.add('tracking');
}

// Update the toggleJson function
function toggleJson(button) {
    const container = button.closest('.post-item').querySelector('.json-container');
    const isHidden = container.style.display === 'none';
    container.style.display = isHidden ? 'block' : 'none';
    button.textContent = isHidden ? '❌' : '🛠️';
    button.classList.toggle('active', isHidden);
}

// Add this function near getExternalEmbed
function getRecordEmbed(record) {
    if (!record.embed || record.embed.$type !== 'app.bsky.embed.record') {
        return null;
    }
    
    const uri = record.embed.record.uri;
    // Extract did and rkey from the uri (at://did:plc:xyz/app.bsky.feed.post/123)
    const [did, rkey] = uri.split('//')[1].split('/app.bsky.feed.post/');
    
    return {
        type: 'record',
        uri: uri,
        url: `https://bsky.app/profile/${did}/post/${rkey}`,
        cid: record.embed.record.cid
    };
}

// Add this function near getImageUrls and getExternalEmbed
function getVideoEmbed(record, did) {
    if (!record.embed || record.embed.$type !== 'app.bsky.embed.video') {
        return null;
    }
    
    return {
        type: 'video',
        aspectRatio: record.embed.video.aspectRatio,
        mimeType: record.embed.video.mimeType
    };
}
