// Add reconnection configuration
const RECONNECT_DELAY_MS = 3000; // Initial delay of 3 seconds
const MAX_RECONNECT_DELAY_MS = 30000; // Maximum delay of 30 seconds
let reconnectAttempts = 0;
let ws = null;

function connect() {
    const url = "wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post&wantedCollections=app.bsky.feed.like";
    
    ws = new WebSocket(url);

    ws.onopen = () => {
        console.log("Connected to BlueSky WebSocket");
        // Reset reconnection attempts on successful connection
        reconnectAttempts = 0;
    };

    ws.onmessage = (event) => {
        const json = JSON.parse(event.data);

        if (json.kind !== 'commit') return;

        if (json.commit.collection === 'app.bsky.feed.post') {
            if (!json.commit.record) return;

            if (json.commit.operation === 'create') {
                posts[json.commit.cid] = {
                    message: json.commit.record.text,
                    facets: json.commit.record.facets,
                    likes: 0,
                    did: json.did,
                    url: `https://bsky.app/profile/${json.did}/post/${json.commit.rkey}`,
                    parentUrl: json.commit.record.reply ? 
                        `https://bsky.app/profile/${json.commit.record.reply.parent.uri.split('//')[1].split('/')[0]}/post/${json.commit.record.reply.parent.uri.split('/').pop()}` : 
                        null,
                    profile: null,
                    images: getImageUrls(json.commit.record, json.did),
                    timestamp: Date.now(),
                    firstLikeTimestamp: null
                };
            }
        }

        if (json.commit.collection === 'app.bsky.feed.like') {
            if (!json.commit.record) return;

            if (json.commit.operation === 'create' && json.commit.record.subject.cid in posts) {
                const post = posts[json.commit.record.subject.cid];
                if (post.likes === 0) {
                    post.firstLikeTimestamp = Date.now();
                }
                post.likes++;
                updateTopPostsList();
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

function updateTopPostsList() {
    const topPostsDiv = document.getElementById('topPosts');
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
            if (likesSpan.textContent !== `❤️ ${post.likes}`) {
                likesSpan.textContent = `❤️ ${post.likes}`;
            }
            
            // Update profile info if it was just fetched
            if (post.profile && existingElement.querySelector('.display-name').textContent === 'Loading...') {
                const profileInfo = existingElement.querySelector('.profile-info');
                profileInfo.innerHTML = `
                    <img src="${post.profile.avatar}" class="avatar" alt="Profile picture">
                    <div class="profile-details">
                        <div class="display-name">${post.profile.displayName}</div>
                        <div class="handle">@${post.profile.handle}</div>
                    </div>
                    <span class="timestamp">${new Date(post.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                `;
                
                // Update profile stats
                const postMeta = existingElement.querySelector('.post-meta');
                const statsHtml = `
                    <div class="profile-stats">
                        <span>👥 ${post.profile.followersCount} followers</span>
                        <span>📝 ${post.profile.postsCount} posts</span>
                    </div>
                    ${postMeta.querySelector('.post-links').outerHTML}
                `;
                postMeta.innerHTML = statsHtml;
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

            newElement.innerHTML = `
                <div class="profile-info">
                    ${post.profile ? 
                        `<img src="${post.profile.avatar}" class="avatar" alt="Profile picture">` : 
                        '<div class="avatar-placeholder"></div>'
                    }
                    <div class="profile-details">
                        <div class="display-name">${post.profile ? post.profile.displayName : 'Loading...'}</div>
                        <div class="handle">${post.profile ? `@${post.profile.handle}` : `@${post.did.slice(0, 8)}...`}</div>
                    </div>
                    <span class="timestamp">${new Date(post.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div class="likes">❤️ ${post.likes}</div>
                <div class="post-content">
                    ${formatMessage(post.message, post.facets)}
                    ${imagesHtml}
                </div>
                <div class="post-meta">
                    ${post.profile ? `
                        <div class="profile-stats">
                            <span>👥 ${post.profile.followersCount.toLocaleString()} followers</span>
                            <span>📝 ${post.profile.postsCount.toLocaleString()} posts</span>
                        </div>
                    ` : ''}
                    <div class="post-links">
                        <a href="${post.url}" target="_blank">View on BlueSky</a>
                        ${post.parentUrl ? `<a href="${post.parentUrl}" target="_blank">View Parent Post</a>` : ''}
                    </div>
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