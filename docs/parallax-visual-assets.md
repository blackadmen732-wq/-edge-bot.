# PARALLAX observatory

The new default entry is the full-screen observatory. Its scene toggle changes between the uploaded galaxy and black-hole reference images. Entry buttons retain the existing data explorer, conversations and paper-performance views. The brand link returns home.

Higgsfield Seedance 2.5 job 1f3f5ad4-93fb-4ece-9e50-f9fe7247444c completed a five-second 16:9 galaxy video. The frontend plays its returned CDN URL, with local reference image fallback. This atmospheric video is not a live market visualization or navigable 3D volume. No backend work was changed. Production should mirror the clip in owned object storage rather than depend indefinitely on the generation CDN.

Motion controls pause the video and ambient stars. Reduced-motion preference starts paused; video is also paused when the opening leaves view. Camera parallax and drift apply to imagery. Rendering caps device pixel ratio and frame rate. Mobile layouts retain the three destinations.

Run `python scripts/build-desk.py` after changing modules or styling to rebuild desktop.html. The assets directory must accompany desktop.html.
