export class Viewport {
    constructor(viewportElement, containerElement) {
        this.el = viewportElement;
        this.container = containerElement;
        this.posX = 0;
        this.posY = 0;
        this.scale = 1.0;
        this.isDragging = false;
        this.lastX = 0;
        this.lastY = 0;

        this.initEvents();
        this.updateTransform();
    }

    initEvents() {
        this.container.onmousedown = (e) => {
            // Only drag if clicking container background or viewport
            if (e.target === this.container || e.target === this.el) {
                this.isDragging = true;
                this.lastX = e.clientX;
                this.lastY = e.clientY;
            }
        };

        window.onmousemove = (e) => {
            if (!this.isDragging) return;
            this.posX += (e.clientX - this.lastX);
            this.posY += (e.clientY - this.lastY);
            this.lastX = e.clientX;
            this.lastY = e.clientY;
            this.updateTransform();
        };

        window.onmouseup = () => {
            this.isDragging = false;
        };
    }

    updateTransform() {
        this.el.style.transform = `translate(${this.posX}px, ${this.posY}px) scale(${this.scale})`;
    }

    pan(dx, dy) {
        this.posX += dx;
        this.posY += dy;
        this.updateTransform();
    }

    zoom(multiplier) {
        this.scale *= multiplier;
        this.updateTransform();
    }

    reset() {
        this.posX = 0;
        this.posY = 0;
        this.scale = 1.0;
        this.updateTransform();
    }
}
