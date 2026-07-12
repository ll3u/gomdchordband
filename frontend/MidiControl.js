/*
 * MidiControl
 *
 * A lightweight vanilla JS library for MIDI input handling (wired & Bluetooth).
 *
 * Features:
 *  - Two learnable MIDI slots
 *  - Supports wired MIDI and Bluetooth LE MIDI devices
 *  - Short press → click trigger button
 *  - Long press → custom callbacks
 *  - Persistent configuration via localStorage
 *  - Mobile-friendly fixed-width dialog

 * Usage:

    ```js
    const midi = new MidiControl({
        triggerBtn: document.getElementById('myButton'),
        onLearn: (data) => console.log('Learned:', data),
        onTrigger: (data) => console.log('Short press:', data),
        onLongPress: (data) => console.log('Long press:', data),
        onRelease: (data) => console.log('Released:', data)
    });

    // Open settings dialog
    document.getElementById('myBtn').addEventListener('click', () => {
        midi.openDialog();
    });
 */
class MidiControl {
    constructor(options = {}) {
        this.triggerBtn = options.triggerBtn;
        this.onLearn = options.onLearn || (() => {});
        this.onTrigger = options.onTrigger || (() => {});
        this.onLongPress = options.onLongPress || (() => {});
        this.onRelease = options.onRelease || (() => {});
        
        this.isLearning = false;
        this.learningTimeout = null;
        this.inputs = new Map();
        this.midiAccess = null;
        this.elements = {};
        this.midiTimer = null;
        this.longPressTriggered = false;
        // track which slot is currently long-pressing
        this.activeLongPressSlot = null; 
        this.LONG_PRESS_DELAY = options.longPressDelay ?? 350;
        this.LEARN_TIMEOUT = options.learnTimeout ?? 10000;
        // track which slot is currently learning (0 or 1)
        this.currentLearningIndex = null;

        this.slotLabels = options.slotLabels || [null, null];

        // configuration item
        this.config = JSON.parse(localStorage.getItem('settings.midiConfig') || 'null') || {
            deviceId: null,
            slots: [
                { type: 'NOTE', note: null },
                { type: 'NOTE', note: null }
            ]
        };

        this.buildUI();
        // moved `this.init();` to openDialog()
    }

    saveConfig() {
        localStorage.setItem('settings.midiConfig', JSON.stringify(this.config));
    }

    async init() {
        if (!navigator.requestMIDIAccess) {
            this.elements.statuses[0].textContent = 'MIDI unsupported';
            return;
        }

        try {
            this.midiAccess = await navigator.requestMIDIAccess();
            this.midiAccess.onstatechange = () => this.updateDeviceList();
            this.updateDeviceList();
        } catch (err) {
            this.elements.statuses[0].textContent = 'MIDI denied';
        }
    }

    updateDeviceList() {
        this.inputs.clear();
        if (!this.midiAccess) return;
        const iter = this.midiAccess.inputs.values();
        
        for (let input = iter.next(); input && !input.done; input = iter.next()) {
            input.value.onmidimessage = (e) => this.handleMidiMessage(e);
            this.inputs.set(input.value.id, input.value);
        }

        if (this.elements.select) this.populateSelect();
    }

    // core function - processes data from both wired and bluetooth MIDI devices
    processIncomingMidi(deviceId, statusByte, data1, data2) {
        // extract type of state
        const stateType = statusByte & 0xF0;
        
        // default filter - accept Note-On (0x90), Note-Off (0x80), Control Change (0xB0)
        let isNoteMsg = (stateType === 0x90 || stateType === 0x80);
        let isCC = (stateType === 0xB0);

        if (!isNoteMsg && !isCC) return; // ignore all other

        const currentType = isCC ? 'CC' : 'NOTE';
        
        /* 
         * default mathematical evaluation for pressing a.k.a. `isPressed`:
         *   a genuine press is ONLY detected if the status is Note-On (0x90) AND the velocity is greater than 0!
         *   if the wired pedal sends 0x80, or the ESP32 sends 0x90 with a velocity of 0, `isPressed` automatically becomes `false` (release).
         */
        const isPressed = (stateType === 0x90 && data2 > 0); 

        // ===== learning mode =====
        if (this.isLearning && this.currentLearningIndex !== null) {
            if (!isPressed) return;
            this.isLearning = false;
            clearTimeout(this.learningTimeout);
            
            this.config.deviceId = deviceId;
            this.config.slots[this.currentLearningIndex].type = currentType;
            this.config.slots[this.currentLearningIndex].note = data1;
            this.saveConfig();
            
            this.elements.learnBtns[this.currentLearningIndex].classList.remove('learning');
            this.elements.learnBtns[this.currentLearningIndex].textContent = 'learn';
            this.updateStatus();
            this.onLearn({ 
                slot: this.currentLearningIndex,
                deviceId: this.config.deviceId, 
                type: this.config.slots[this.currentLearningIndex].type, 
                note: this.config.slots[this.currentLearningIndex].note 
            });
            return;
        }
        
        // ===== midi mode =====
        // check both slots for a match
        let matchedSlot = null;
        for (let i = 0; i < this.config.slots.length; i++) {
            const slot = this.config.slots[i];
            if (slot.note === data1 && slot.type === currentType) {
                matchedSlot = i;
                break;
            }
        }

        // no slot matched - ignore the input
        if (matchedSlot === null) {
            return; 
        }

        if (matchedSlot !== null) {
            // special case: ControlChange (backwards compatibility)
            if (currentType === 'CC') {
                if (!isPressed) return;
                if (!this.config.deviceId || this.config.deviceId === deviceId) {
                    if (this.triggerBtn) this.triggerBtn.click();
                    this.onTrigger({ type: this.config.slots[matchedSlot].type, note: this.config.slots[matchedSlot].note });
                    this.flashTrigger(matchedSlot);
                }
                return;
            }

            // main case: real midi noteOn/Off (support 0x90 velocity: 0 and 0x80 noteOff)
            if (isPressed) {
                // If another slot is already in long-press mode, ignore this press
                if (this.activeLongPressSlot !== null) {
                    return;
                }
                
                clearTimeout(this.midiTimer);
                
                // Start timeout for long-press detection
                this.midiTimer = setTimeout(() => {
                    // === LONG PRESS DETECTED ===
                    this.activeLongPressSlot = matchedSlot;
                    this.longPressHandled = this.onLongPress({ type: 'HOLD', note: data1 }) !== undefined;
                    if (this.longPressHandled) {
                        this.flashTrigger(matchedSlot);
                    }
                }, this.LONG_PRESS_DELAY);

            // === RELEASING ===
            } else {
                clearTimeout(this.midiTimer);
                
                if (this.activeLongPressSlot === matchedSlot) {
                    // === RELEASE FROM LONG PRESS ===
                    this.onRelease({ type: 'RELEASE', note: data1 });
                    this.activeLongPressSlot = null;
                } else if (this.activeLongPressSlot === null) {
                    // === SHORT CLICK (no active long-press on ANY slot) ===
                    if (!this.config.deviceId || this.config.deviceId === deviceId) {
                        if (this.triggerBtn) this.triggerBtn.click();
                    }
                    this.onTrigger({ type: 'CLICK', note: data1 });
                    this.flashTrigger(matchedSlot);
                }
                // If releasing while another slot is long-pressing, do nothing
            }
        }
    }

    handleMidiMessage(event) {
        const [status, data1, data2] = event.data;
        this.processIncomingMidi(event.target.id, status, data1, data2);
    }
    
    async connectBluetoothMidi() {
        const MIDI_SERVICE_UUID = "03b19c24-b6a4-11e2-91e5-0002a5d5c51b";
        this.elements.statuses[0].textContent = 'Scanning BLE...';

        try {
            const device = await navigator.bluetooth.requestDevice({
                filters: [{ services: [MIDI_SERVICE_UUID] }]
            });

            this.elements.statuses[0].textContent = 'Connecting BLE...';
            const server = await device.gatt.connect();
            const service = await server.getPrimaryService(MIDI_SERVICE_UUID);
            const characteristics = await service.getCharacteristics();
            
            if (characteristics.length === 0) throw new Error("No MIDI characteristic");
            const midiChar = characteristics[0];

            await midiChar.startNotifications();
            
            // register the BLE devices to the select
            const opt = document.createElement('option');
            opt.value = device.id;
            opt.textContent = `[BLE] ${device.name}`;
            opt.selected = true;
            this.elements.select.appendChild(opt);
            this.config.deviceId = device.id;
            this.saveConfig();

            // listen on BLE-MIDI packages
            midiChar.addEventListener('characteristicvaluechanged', (event) => {
                const value = event.target.value;
                // BLE-MIDI package: 2nd byte == state , 3rd byte == Data1, 4th byte == Data2
                if (value.byteLength >= 5) {
                    const bleStatus = value.getUint8(2);
                    const bleData1  = value.getUint8(3);
                    const bleData2  = value.getUint8(4);
                    this.processIncomingMidi(device.id, bleStatus, bleData1, bleData2);
                }
            });

            this.elements.statuses[0].textContent = 'BLE connected!';
            this.updateStatus();

            device.addEventListener('gattserverdisconnected', () => {
                this.elements.statuses[0].textContent = 'BLE disconnected';
            });

        } catch (err) {
            console.error(err);
            this.elements.statuses[0].textContent = 'BLE failed / canceled';
        }
    }

    buildUI() {
        const overlay = document.createElement('div');
        overlay.className = 'mc-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'mc-dialog';

        // --- Header ---
        const header = document.createElement('div');
        header.className = 'mc-header';

        const title = document.createElement('span');
        title.className = 'mc-title';
        title.textContent = 'MIDI Settings';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'mc-close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => this.closeDialog());

        header.appendChild(title);
        header.appendChild(closeBtn);
        dialog.appendChild(header);

        // 1st line: Bluetooth Connect Button
        const bleBtn = document.createElement('button');
        bleBtn.className = 'mc-ble-connect';
        bleBtn.innerHTML = `
        <svg class="mdi-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
            <path d="M0 0h24v24H0z" fill="none" />
            <path fill="currentColor" d="M3.464 3.464C2 4.93 2 7.286 2 12s0 7.071 1.464 8.535C4.93 22 7.286 22 12 22s7.071 0 8.535-1.465C22 19.072 22 16.714 22 12s0-7.071-1.465-8.536C19.072 2 16.714 2 12 2S4.929 2 3.464 3.464" opacity=".5" />
            <path fill="currentColor" d="m12.448 16.774l-.001-.003z" />
            <path fill="currentColor" fill-rule="evenodd" d="M12.788 6.196c.253.135.547.351.854.578L15.02 7.79c.211.155.428.315.587.471c.179.177.393.455.393.852s-.214.674-.393.852a6 6 0 0 1-.587.471L12.898 12l2.122 1.564c.211.155.428.315.587.471c.179.178.393.455.393.852s-.214.675-.393.852a6 6 0 0 1-.587.471l-1.378 1.016c-.307.227-.6.443-.854.578c-.258.138-.701.316-1.172.084c-.472-.232-.593-.686-.636-.972c-.041-.28-.041-.64-.041-1.018V13.54l-1.734 1.42a.744.744 0 0 1-1.035-.093a.713.713 0 0 1 .094-1.017L10.526 12l-2.262-1.851a.713.713 0 0 1-.094-1.017a.744.744 0 0 1 1.035-.092l1.734 1.419V8.102c0-.378 0-.738.041-1.018c.043-.286.164-.74.636-.972c.471-.231.914-.054 1.172.084m-.38 9.654v-2.406l1.698 1.25q.153.112.259.193l-.259.193l-1.306.962c-.156.115-.283.208-.39.283a27 27 0 0 1-.002-.475m.04.924l-.001-.003zm-.04-8.624v2.406l1.698-1.25q.153-.112.259-.193l-.259-.193l-1.306-.962a28 28 0 0 0-.39-.283a27 27 0 0 0-.002.475" clip-rule="evenodd" />
        </svg>
        <span>connect</span>
        `;
        bleBtn.style.width = '100%';
        bleBtn.style.marginBottom = '10px';
        bleBtn.style.padding = '8px';
        bleBtn.addEventListener('click', () => this.connectBluetoothMidi());
        dialog.appendChild(bleBtn);
        this.elements.bleBtn = bleBtn;

        // arrays
        this.elements.learnBtns = [];
        this.elements.statuses = [];

        // 2nd line: Two learn buttons side by side
        const buttonsRow = document.createElement('div');
        buttonsRow.className = 'mc-buttons-row';

        for (let i = 0; i < 2; i++) {
            const learnBtn = document.createElement('button');
            learnBtn.className = 'mc-learn';
            learnBtn.textContent = this.getSlotLabel(i);
            learnBtn.addEventListener('click', () => this.startLearning(i));
            buttonsRow.appendChild(learnBtn);
            this.elements.learnBtns.push(learnBtn);
        }

        dialog.appendChild(buttonsRow);

        // 3rd line: Two status displays side by side
        const statusesRow = document.createElement('div');
        statusesRow.className = 'mc-statuses-row';

        for (let i = 0; i < 2; i++) {
            const status = document.createElement('div');
            status.className = 'mc-status';
            status.textContent = 'No mapping learned yet';
            statusesRow.appendChild(status);
            this.elements.statuses.push(status);
        }

        dialog.appendChild(statusesRow);

        // 4th line: Device select
        const select = document.createElement('select');
        select.className = 'mc-select';
        dialog.appendChild(select);
        select.addEventListener('change', (e) => {
            this.config.deviceId = e.target.value || null;
            this.saveConfig();
        });
        this.elements.select = select;

        // Backward compatibility
        this.elements.learnBtn = this.elements.learnBtns[0];
        this.elements.status = this.elements.statuses[0];

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        this.elements.overlay = overlay;

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.closeDialog();
        });

        this.updateStatus();
        this.populateSelect();
    }

    openDialog() {
        // request MIDI only access when dialog is opened
        if (!this.midiAccess) {
            this.init();
        }
        this.elements.overlay.classList.add('open');
    }

    closeDialog() {
        this.elements.overlay.classList.remove('open');
        if (this.isLearning) {
            this.isLearning = false;
            this.currentLearningIndex = null;
            clearTimeout(this.learningTimeout);
            this.elements.learnBtns.forEach((btn, i) => {
                btn.classList.remove('learning');
                btn.textContent = 'learn';
            });
            this.updateStatus();
        }
        this.activeLongPressSlot = null;
    }

    populateSelect() {
        if (!this.elements.select) return;
        this.elements.select.innerHTML = '';
        this.inputs.forEach((input, id) => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = input.name;
            if (id === this.config.deviceId) opt.selected = true;
            this.elements.select.appendChild(opt);
        });
    }

    startLearning(index) {
        // Remove learning state from all buttons first
        this.elements.learnBtns.forEach(btn => btn.classList.remove('learning'));
        
        this.isLearning = true;
        this.currentLearningIndex = index;
        this.elements.learnBtns[index].classList.add('learning');
        this.elements.learnBtns[index].textContent = 'waiting...';
        this.elements.statuses[index].textContent = 'Press pedal or key...';
        // auto-cancel learn mode within 10 seconds
        this.learningTimeout = setTimeout(() => {
            if (this.isLearning) {
                this.isLearning = false;
                this.currentLearningIndex = null;
                this.elements.learnBtns[index].classList.remove('learning');
                this.elements.learnBtns[index].textContent = 'learn';
                this.elements.statuses[index].textContent = 'Learn cancelled (timeout)';
                this.updateStatus();
            }
        }, this.LEARN_TIMEOUT);
    }

    updateStatus() {
        this.elements.statuses.forEach((status, i) => {
            const slot = this.config.slots[i];
            if (slot.note !== null) {
                status.textContent = slot.type === 'CC' 
                    ? `CC #${slot.note}` 
                    : `Note: ${this.midiToNote(slot.note)}`;
            } else {
                status.textContent = 'No mapping learned yet';
            }
        });

        this.elements.learnBtns.forEach((btn, i) => {
            const slot = this.config.slots[i];
            btn.textContent = this.getSlotLabel(i);
            /*
            if (slot.note !== null) {
                btn.textContent = this.midiToNote(slot.note);
            } else {
                btn.textContent = this.getSlotLabel(i);
            }*/
        });
    }

    flashTrigger(index) {
        if (this.elements.learnBtns[index]) {
            this.elements.learnBtns[index].style.borderColor = 'var(--accent)';
            this.elements.learnBtns[index].style.color = 'var(--accent)';
            setTimeout(() => {
                this.elements.learnBtns[index].style.borderColor = '';
                this.elements.learnBtns[index].style.color = '';
            }, 100);
        }
    }

    midiToNote(midi) {
        const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const octave = Math.floor(midi / 12) - 1;
        return `${notes[midi % 12]}${octave}`;
    }

    getSlotLabel(index) {
        return this.slotLabels[index] ?? (index === 0 ? 'Left' : 'Right');
    }
}
