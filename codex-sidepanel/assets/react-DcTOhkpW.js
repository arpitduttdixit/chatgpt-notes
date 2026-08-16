import{o as e}from"./rolldown-runtime-DAXXjFlN.js";import{r as t}from"./jsx-runtime-BJvgpPfO.js";import{a as n,o as r,s as i}from"./persisted-atom-eFbuFKs_.js";var a=e(t(),1),o=(0,a.createContext)(void 0);function s(e){let t=(0,a.useContext)(o);return e?.store||t||r()}function c({children:e,store:t}){let r=(0,a.useRef)(null);return t?(0,a.createElement)(o.Provider,{value:t},e):(r.current===null&&(r.current=n()),(0,a.createElement)(o.Provider,{value:r.current},e))}var l=e=>typeof e?.then==`function`,u=e=>{e.status||(e.status=`pending`,e.then(t=>{e.status=`fulfilled`,e.value=t},t=>{e.status=`rejected`,e.reason=t}))},d=a.use||(e=>{if(e.status===`pending`)throw e;if(e.status===`fulfilled`)return e.value;throw e.status===`rejected`?e.reason:(u(e),e)}),f=new WeakMap,p=(e,t,n)=>{let r=i(e),a=r[26],o=f.get(t);return o||(o=new Promise((i,s)=>{let c=t,u=e=>t=>{c===e&&i(t)},d=e=>t=>{c===e&&s(t)},p=()=>{try{let t=n();l(t)?(f.set(t,o),c=t,t.then(u(t),d(t)),a(r,e,t,p)):i(t)}catch(e){s(e)}};t.then(u(t),d(t)),a(r,e,t,p)}),f.set(t,o)),o};function m(e,t){let{delay:n,unstable_promiseStatus:r=!a.use}=t||{},i=s(t),[[o,c,f],m]=(0,a.useReducer)(t=>{let n=i.get(e);return Object.is(t[0],n)&&t[1]===i&&t[2]===e?t:[n,i,e]},void 0,()=>[i.get(e),i,e]),h=o;if((c!==i||f!==e)&&(m(),h=i.get(e)),(0,a.useEffect)(()=>{let t=i.sub(e,()=>{if(r)try{let t=i.get(e);l(t)&&u(p(i,t,()=>i.get(e)))}catch{}if(typeof n==`number`){console.warn(`[DEPRECATED] delay option is deprecated and will be removed in v3.

Migration guide:

Create a custom hook like the following.

function useAtomValueWithDelay<Value>(
  atom: Atom<Value>,
  options: { delay: number },
): Value {
  const { delay } = options
  const store = useStore(options)
  const [value, setValue] = useState(() => store.get(atom))
  useEffect(() => {
    const unsub = store.sub(atom, () => {
      setTimeout(() => setValue(store.get(atom)), delay)
    })
    return unsub
  }, [store, atom, delay])
  return value
}
`),setTimeout(m,n);return}m()});return m(),t},[i,e,n,r]),(0,a.useDebugValue)(h),l(h)){let t=p(i,h,()=>i.get(e));return r&&u(t),d(t)}return h}function h(e,t){let n=s(t);return(0,a.useCallback)((...t)=>n.set(e,...t),[n,e])}function g(e,t){return[m(e,t),h(e,t)]}export{s as a,h as i,g as n,m as r,c as t};