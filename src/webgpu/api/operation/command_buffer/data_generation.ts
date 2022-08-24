// A helper function that generates ranges of dummy data for buffer or texture operations
// efficiently. Tries to minimize allocations and data updates.
export class DataArrayGenerator {
  private dataBuffer = new Uint8Array(256);

  private lastOffset = 0;
  private lastStart = 0;
  private lastByteSize = 0;

  // Find the nearest power of two greater than or equal to the input value.
  private nextPowerOfTwo(value: number) {
    return 1 << (32 - Math.clz32(value - 1));
  }

  private generateData(byteSize: number, start: number = 0, offset: number = 0) {
    const prevSize = this.dataBuffer.length;

    if (prevSize < byteSize) {
      // If the requested data is larger than the allocated buffer, reallocate it to a buffer large
      // enough to handle the new request.
      const newData = new Uint8Array(this.nextPowerOfTwo(byteSize));

      if (this.lastOffset === offset && this.lastStart === start && this.lastByteSize) {
        // Do a fast copy of any previous data that was generated.
        newData.set(this.dataBuffer);
      }

      this.dataBuffer = newData;
    } else if (this.lastOffset < offset) {
      // Ensure all values up to the offset are zeroed out.
      this.dataBuffer.fill(0, this.lastOffset, offset);
    }

    // If the offset or start values have changed, the whole data range needs to be regenerated.
    if (this.lastOffset !== offset || this.lastStart !== start) {
      this.lastByteSize = 0;
    }

    // Generate any new values that are required
    if (this.lastByteSize < byteSize) {
      for (let i = this.lastByteSize; i < byteSize - offset; ++i) {
        this.dataBuffer[i + offset] = ((i ** 3 + i + start) % 251) + 1; // Ensure data is always non-zero
      }

      this.lastOffset = offset;
      this.lastStart = start;
      this.lastByteSize = byteSize;
    }
  }

  // Returns a new into the generated data that's the correct length. Because this is a view any
  // previously returned views from the same generator will have their values overwritten as well.
  generateView(byteSize: number, start: number = 0, offset: number = 0): Uint8Array {
    this.generateData(byteSize, start, offset);

    if (this.dataBuffer.length === byteSize) {
      return this.dataBuffer;
    }
    return new Uint8Array(this.dataBuffer.buffer, 0, byteSize);
  }

  // Returns a copy of the generated data. Note that this still changes the underlying buffer, so
  // any previously generated views will still be overwritten, but the returned copy won't reflect
  // future generate* calls.
  generateAndCopyView(byteSize: number, start: number = 0, offset: number = 0) {
    this.generateData(byteSize, start, offset);
    return this.dataBuffer.slice(0, byteSize);
  }
}
