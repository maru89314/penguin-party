# Summary of penguin-party Handover Notes

This document outlines a Node.js/Express/Socket.io multiplayer card game project with recent fixes.

## Recent Improvements

The team addressed sleep-mode reconnection issues on Render.com's free tier by:

- Adding a `rejoinRoom` event handler to restore game state using player name and room code
- Implementing a 30-second grace period before removing players mid-game (versus immediate removal in lobbies)
- Configuring Socket.io with infinite reconnection attempts and 1-second delays
- Displaying a reconnection overlay with spinner during disconnections
