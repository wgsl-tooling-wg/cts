# WESL Fork of the WebGPU Conformance Test Suite

To run it, do the following

```
cd ../tools/packages/wesl
pnpm run build
cd ../../../cts

npm start 
```

and then go to [http://localhost:8080/standalone/?q=webgpu:shader,validation,parse,*](http://localhost:8080/standalone/?q=webgpu:shader,validation,parse,*)