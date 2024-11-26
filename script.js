// const url = "wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post&wantedCollections=app.bsky.feed.like&wantedCollections=app.bsky.graph.follow";

const url = "wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post&wantedCollections=app.bsky.feed.like";

const ws = new WebSocket(url);
ws.onopen = () => {
    console.log("Connected to BlueSky WebSocket");
};

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

function updateTopPostsList() {
    const topPostsDiv = document.getElementById('topPosts');
    const postsArray = Object.entries(posts)
        .filter(([_, post]) => post.likes > 0)
        .sort((a, b) => b[1].likes - a[1].likes)
        .slice(0, 20);
    
    // Check for posts that need profile fetching
    postsArray.forEach(([cid, post]) => {
        if (!post.profile && post.likes >= 10) {
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
                </div>
                <span class="likes">❤️ ${post.likes}</span>
                <p>${formatMessage(post.message, post.facets)}</p>
                <div class="post-meta">
                    ${post.profile ? `
                        <div class="profile-stats">
                            <span>👥 ${post.profile.followersCount} followers</span>
                            <span>📝 ${post.profile.postsCount} posts</span>
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
                profile: null
            };
        }
    }

    if (json.commit.collection === 'app.bsky.feed.like') {
        if (!json.commit.record) return;

        if (json.commit.operation === 'create' && json.commit.record.subject.cid in posts) {
            const post = posts[json.commit.record.subject.cid];
            post.likes++;
            updateTopPostsList();
        }
    }
};

ws.onerror = (error) => {
    console.error("WebSocket error:", error);
};

ws.onclose = () => {
    console.log("WebSocket connection closed");
};